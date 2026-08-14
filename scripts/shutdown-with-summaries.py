#!/usr/bin/env python3
"""
Clean ACP shutdown with session summary generation.

Generates Qwen summaries for all agent sessions before killing the ACP.
Summaries stored in kb with title '*session summary*' for auto-injection on next boot.

Usage:
  python shutdown-with-summaries.py [--no-summaries] [--kill-pid <pid>] [--no-kill]

--no-summaries  : skip summary generation (fast shutdown for testing)
--kill-pid      : directly kill this PID instead of searching (e.g., acp-api's node process)
--no-kill       : skip process kill (for use in before-quit handler, which handles it)
"""
import argparse
import json
import os
import re
import subprocess
import sys
import tempfile
import urllib.request
from pathlib import Path

OLLAMA = os.environ.get("KB_OLLAMA_URL", "http://10.0.0.220:11434")
KB_REMEMBER = Path("E:/Repos/.claude/hooks/kb_remember.py")
OLLAMA_HEALTH_TIMEOUT = 2  # Don't wait long for health check


def is_ollama_available() -> bool:
    """Check if Ollama is already running."""
    try:
        with urllib.request.urlopen(f"{OLLAMA}/api/tags", timeout=OLLAMA_HEALTH_TIMEOUT) as r:
            r.read()
            return True
    except Exception:
        return False


def start_ollama_if_needed():
    """Start Ollama if not running. Wait up to 10s for it to respond."""
    if is_ollama_available():
        print("[ok] Ollama already running")
        return True

    print("[starting] Ollama...")
    try:
        subprocess.Popen(
            ["ollama", "serve"],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            creationflags=subprocess.CREATE_NEW_PROCESS_GROUP if hasattr(subprocess, 'CREATE_NEW_PROCESS_GROUP') else 0
        )
    except Exception as e:
        print(f"[error] Could not start Ollama: {e}")
        return False

    # Wait up to 10s for Ollama to become responsive
    import time
    for attempt in range(20):
        if is_ollama_available():
            print("[ok] Ollama ready")
            return True
        time.sleep(0.5)

    print("[error] Ollama failed to start within 10s")
    return False


def estimate_tokens(text: str) -> int:
    """Rough token estimate: ~4 chars per token (Claude/GPT estimate)."""
    return len(text) // 4


def summarize_with_qwen(transcript_text: str, agent_name: str, max_tokens: int = 1500) -> tuple[str, int]:
    """
    Call Qwen 2.5 to generate a session summary.
    Returns (summary_text, token_estimate).
    """
    prompt = f"""Summarize this {agent_name} session transcript concisely.

Format:
1. A 2-3 sentence overall summary of what was accomplished
2. Detailed bulleted list of key moments/decisions (the last parts are MOST important)

Keep it tight enough to fit in ~1500 tokens when used as boot context. If you must choose, favor recency.

---
TRANSCRIPT:
{transcript_text[:8000]}  # First 8k chars (most recent is at the end, usually)
"""

    req = urllib.request.Request(
        f"{OLLAMA}/api/generate",
        data=json.dumps({
            "model": "qwen2.5-coder:7b",
            "prompt": prompt,
            "stream": False,
            "temperature": 0.3,  # Lower temp for consistency
        }).encode(),
        headers={"Content-Type": "application/json"}
    )

    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            result = json.load(r)
            summary = result.get("response", "").strip()
            token_estimate = estimate_tokens(summary)
            return summary, token_estimate
    except Exception as e:
        print(f"[warn] Qwen summarize failed for {agent_name}: {e}")
        return "", 0


def find_agent_transcripts() -> dict:
    """Find all agent session transcripts in ~/.claude/projects/"""
    transcripts = {}
    projects_dir = Path.home() / ".claude" / "projects"

    if not projects_dir.exists():
        print(f"[info] No projects dir found at {projects_dir}")
        return transcripts

    for agent_dir in projects_dir.iterdir():
        if not agent_dir.is_dir():
            continue

        agent_name = agent_dir.name

        # Find the most recent .jsonl transcript
        jsonl_files = list(agent_dir.glob("**/*.jsonl"))
        if not jsonl_files:
            continue

        latest_jsonl = max(jsonl_files, key=lambda p: p.stat().st_mtime)

        try:
            # Read transcript
            content = latest_jsonl.read_text(errors="ignore")
            transcripts[agent_name] = content
            print(f"[found] {agent_name}: {len(content)} bytes")
        except Exception as e:
            print(f"[error] Reading {agent_name} transcript: {e}")

    return transcripts


def cleanup_old_summaries(agent_name: str) -> None:
    """Remove old session summaries for this agent to avoid accumulation."""
    ssh_cmd = ('ssh -i ~/.ssh/dotnetpert_93 dotnetpert@10.0.0.93 '
               '"sudo docker exec -i kb-postgres psql -U kb -d kb -v ON_ERROR_STOP=1 -tA"')
    # Mark old summaries as expired so they don't clutter queries
    sql = (
        f"UPDATE kb SET expires_at = now() "
        f"WHERE scope = 'agent' AND scope_id = '{agent_name}' "
        f"AND title LIKE '%session%' AND expires_at IS NULL "
        f"AND created_at < now() - interval '1 second';"
    )
    try:
        subprocess.run(
            ssh_cmd,
            input=sql.encode(),
            capture_output=True,
            timeout=10
        )
        # Don't log on success — cleanup is silent
    except Exception as e:
        print(f"[warn] cleanup failed for {agent_name}: {e}")


def store_summary_in_kb(agent_name: str, full_summary: str, token_estimate: int) -> bool:
    """
    Store session summary in kb using kb_remember.py.
    Creates TWO entries:
    1. Full session dump (searchable, agents can query via RAG)
    2. Short keyword summary (boot injection, ~300 tokens, all agents)

    Rejects full summaries > 2000 tokens; short summary always stores.
    Old summaries are marked as expired to keep the KB clean.
    """
    MAX_FULL_TOKENS = 2000
    MAX_SHORT_TOKENS = 300

    if not full_summary or not full_summary.strip():
        print(f"[skip] Empty summary for {agent_name}")
        return False

    if not KB_REMEMBER.exists():
        print(f"[error] kb_remember.py not found at {KB_REMEMBER}")
        return False

    # Cleanup: expire old summaries for this agent
    cleanup_old_summaries(agent_name)

    # Store FULL summary in KB (searchable for agents via RAG)
    # Only store if under size limit (otherwise it balloons RAG query costs)
    if token_estimate <= MAX_FULL_TOKENS:
        try:
            cmd = [
                "python", str(KB_REMEMBER),
                "--title", f"{agent_name} session dump (full)",
                "--scope", "agent",
                "--id", agent_name,
                "--source", "shutdown-with-summaries.py (Qwen 2.5 full dump)",
            ]
            proc = subprocess.run(
                cmd,
                input=full_summary.encode(),
                capture_output=True,
                timeout=30
            )
            if proc.returncode == 0:
                print(f"[stored] {agent_name} full session dump in kb ({token_estimate} tokens)")
            else:
                print(f"[warn] kb_remember failed for full dump: {proc.stderr.decode()}")
        except Exception as e:
            print(f"[warn] Storing full dump for {agent_name}: {e}")
    else:
        print(f"[skip] {agent_name} full summary too large ({token_estimate} tokens), storing short only")

    # Create SHORT summary for boot injection (extract first section + keywords)
    lines = full_summary.split('\n')
    short_lines = []
    for line in lines[:10]:  # Take first ~10 lines (usually covers the 2-3 sentence summary)
        if line.strip():
            short_lines.append(line)
        if len('\n'.join(short_lines)) > 1200:  # Stop if we exceed ~300 tokens
            break

    short_summary = '\n'.join(short_lines)
    if not short_summary:
        short_summary = full_summary[:500]  # Fallback: first 500 chars

    # Add RAG query note
    short_summary += "\n\n[The full session is available in the KB for detailed reference — query it if you need context on specific work items.]"

    # Store SHORT summary in KB (all agents get this at boot)
    try:
        cmd = [
            "python", str(KB_REMEMBER),
            "--title", f"{agent_name} session summary (short)",
            "--scope", "agent",
            "--id", agent_name,
            "--source", "shutdown-with-summaries.py (Qwen 2.5 short for boot)",
        ]
        proc = subprocess.run(
            cmd,
            input=short_summary.encode(),
            capture_output=True,
            timeout=30
        )
        if proc.returncode == 0:
            short_tokens = estimate_tokens(short_summary)
            print(f"[stored] {agent_name} short summary in kb ({short_tokens} tokens)")
            return True
        else:
            print(f"[error] kb_remember failed for short summary: {proc.stderr.decode()}")
            return False
    except Exception as e:
        print(f"[error] Storing short summary for {agent_name}: {e}")
        return False


def kill_acp_process(pid: int = None) -> bool:
    """Kill the ACP process cleanly."""
    if pid:
        # Direct kill by PID
        try:
            import signal
            os.kill(pid, signal.SIGTERM)
            print(f"[killed] PID {pid}")
            return True
        except Exception as e:
            print(f"[error] Could not kill PID {pid}: {e}")
            return False

    # Otherwise: kill npm/node on port 40020 (acp-electron) and 3001 (acp-api)
    # This is the slow path — avoid it by passing --kill-pid
    try:
        subprocess.run(["taskkill", "/F", "/IM", "node.exe"],
                      capture_output=True, timeout=5)
        subprocess.run(["taskkill", "/F", "/IM", "npm.cmd"],
                      capture_output=True, timeout=5)
        print("[killed] ACP processes")
        return True
    except Exception as e:
        print(f"[warn] taskkill failed: {e}")
        return False


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--no-summaries", action="store_true",
                   help="Skip summary generation (fast shutdown)")
    p.add_argument("--kill-pid", type=int, default=None,
                   help="Kill this specific PID instead of searching")
    p.add_argument("--no-kill", action="store_true",
                   help="Skip process kill (for before-quit handler, which handles it)")
    args = p.parse_args()

    print("[start] ACP shutdown with summaries")

    # Step 1: Generate summaries (unless --no-summaries)
    if not args.no_summaries:
        if not start_ollama_if_needed():
            print("[skip] Ollama unavailable — agents will boot fresh")
        else:
            print("[step] Generating session summaries via Qwen...")
            transcripts = find_agent_transcripts()

            if transcripts:
                stored = 0
                rejected = 0
                for agent_name, transcript in transcripts.items():
                    print(f"[summarize] {agent_name}...")
                    summary, token_estimate = summarize_with_qwen(transcript, agent_name)
                    if summary:
                        if store_summary_in_kb(agent_name, summary, token_estimate):
                            stored += 1
                        else:
                            rejected += 1
                print(f"[summary] Stored: {stored}, Rejected (oversized): {rejected}")
            else:
                print("[info] No transcripts found")

    # Step 2: Kill ACP (unless --no-kill)
    if not args.no_kill:
        print("[step] Shutting down ACP...")
        kill_acp_process(args.kill_pid)
    else:
        print("[step] Skipping process kill (--no-kill)")

    print("[done] Shutdown complete")
    return 0


if __name__ == "__main__":
    sys.exit(main())
