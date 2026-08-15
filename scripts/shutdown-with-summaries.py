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
# Summariser ladder: the fast local model first, a bigger local one as the
# last resort when the fast one collapses on a long transcript. Both local,
# both free — no account tokens are spent summarising.
SUMMARY_MODEL = os.environ.get("SUMMARY_MODEL", "qwen2.5-coder:7b")
# MUST FIT IN VRAM. Default was gemma4:26b — 17GB on an 8GB card, so it was never
# resident and its every use evicted the models that were. If you override this,
# check `ollama list` against `nvidia-smi` first: a model larger than the card does
# not degrade gracefully, it takes the working models down with it.
SUMMARY_FALLBACK_MODEL = os.environ.get("SUMMARY_FALLBACK_MODEL", "qwen2.5-coder:7b")
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
    # (see distill_transcript below — the tail is what matters)
    # THE TAIL, DISTILLED. This used to pass `transcript_text[:8000]` — the
    # FIRST 8k characters of a file that runs to megabytes — while the comment
    # beside it said "most recent is at the end" and the prompt said "favor
    # recency". So every summary described the boot preamble: "the session began
    # with the user receiving a list of available tools and agents." Accurate,
    # and worth nothing to an agent trying to pick the work back up.
    #
    # Raw jsonl is also the wrong food: most of its bytes are tool_use blobs and
    # metadata, so 8k of raw JSON is a handful of messages. Distil to role +
    # text + tool names first, then take the END.
    convo = distill_transcript(transcript_text, max_chars=24000)

    instructions = f"""You are writing a handoff note for {agent_name}, a software agent whose
session is ending. They will read this at the start of their next session, with
no memory of this one. Write it TO them, in second person.

Cover, in this order:
1. What they were working on — the actual task, with real names: files, cards, branches, agents.
2. What is DONE and verified, versus what is claimed but unverified.
3. What is IN FLIGHT right now — the thing they were mid-way through.
4. What to do NEXT, concretely enough to act on without re-reading anything.
5. Open questions, blockers, or decisions awaiting someone else.

Rules:
- Specifics only. Names, ids, paths, numbers. No "various tasks" or "several improvements".
- Say nothing about tool listings, available agents, skills, or session startup. That is scaffolding, not work.
- If something was tried and failed, say so and why — that is the most valuable line you can write.
- No preamble, no sign-off. Under 400 words."""

    # num_ctx must be set explicitly: Ollama's default context is far smaller
    # than this prompt, and an over-long prompt comes back as a bare HTTP 500 —
    # which is how the two biggest transcripts (the two that most needed a
    # summary) silently produced none. `temperature` also belongs inside
    # `options` for /api/generate; at the top level it is ignored.
    def call(model: str, convo_text: str, timeout: int) -> str:
        body = instructions + "\n---\nEND OF SESSION (most recent last):\n" + convo_text
        req = urllib.request.Request(
            f"{OLLAMA}/api/generate",
            data=json.dumps({
                "model": model,
                "prompt": body,
                "stream": False,
                "options": {"num_ctx": 16384, "temperature": 0.3},
            }).encode(),
            headers={"Content-Type": "application/json"},
        )
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.load(r).get("response", "").strip()

    # A ladder, not a single shot. The 7b model collapses into repetition on the
    # longest, noisiest transcripts — which belong to the agents who did the most
    # work and most need a handoff. Shrinking the input fixes most of those; the
    # bigger local model catches the rest. Both are free and this runs once, at
    # shutdown, so the only cost of trying harder is a little wall-clock.
    # RUNG 3 SHRINKS THE INPUT AGAIN — IT DOES NOT REACH FOR A BIGGER MODEL.
    #
    # It used to be (gemma4:26b, convo[-14000:], 600). gemma4:26b is SEVENTEEN
    # GIGABYTES and this box has an 8GB card. It can never be resident, so every
    # time that rung fired Ollama evicted qwen and nomic, spilled the model to CPU
    # (measured 73%/27% CPU/GPU), and ground for up to ten minutes PER AGENT.
    #
    # Worse than slow: that eviction window is almost certainly the source of the
    # '@@@@@@@@' degeneracy that has been corrupting mail briefs. A concurrent qwen
    # generation issued while the card is being torn down for a model that does not
    # fit returns garbage rather than an error. It reproduced nowhere in isolated
    # testing precisely because gemma4 was not loaded during those tests.
    #
    # A fallback that cannot fit in memory is not a fallback, it is an outage with
    # a retry's name on it. Rung 3 now attacks the ACTUAL failure mode — rungs 1
    # and 2 fail on the longest, noisiest transcripts — by cutting the input
    # further on a model that is already resident.
    attempts = [
        (SUMMARY_MODEL, convo, 180),
        (SUMMARY_MODEL, convo[-9000:], 180),
        (SUMMARY_FALLBACK_MODEL, convo[-5000:], 300),
    ]
    for model, text, timeout in attempts:
        try:
            summary = call(model, text, timeout)
        except Exception as e:
            print(f"[warn] {agent_name}: {model} failed ({e})")
            continue
        if summary and not is_degenerate(summary):
            return summary, estimate_tokens(summary)
        print(f"[warn] {agent_name}: {model} returned degenerate output on {len(text)} chars — shrinking/escalating")

    print(f"[warn] {agent_name}: no usable summary after {len(attempts)} attempts")
    return "", 0


ACP_API = os.environ.get("ACP_API_URL", "http://127.0.0.1:3001").rstrip("/")


def live_roster() -> set:
    """Agent names the rig actually knows about.

    The summary is looked up at boot by EXACT agent name
    (sessionSummary.ts: `scope_id = $1`, deliberately never a prefix), so a row
    stored under anything else is invisible forever. Gating on the real roster
    keeps junk keys — temp probe dirs, other repos' sessions — out of the kb
    instead of storing summaries nobody can ever read.
    """
    # Explicit roster wins. THE ORDERING TRAP: this script's whole job runs at
    # shutdown, and the ACP API is one of the things shutting down — so asking
    # it for the roster works from the before-quit handler (API still alive) and
    # fails from any hard kill or after-the-fact run, storing NOTHING at exactly
    # the moment summaries matter most. A caller that already knows the team can
    # say so.
    override = os.environ.get("SUMMARY_ROSTER", "").strip()
    if override:
        names = {n.strip() for n in override.split(",") if n.strip()}
        print(f"[roster] {len(names)} from SUMMARY_ROSTER (API not consulted)")
        return names

    try:
        req = urllib.request.Request(f"{ACP_API}/v1/mail/agents")
        req.add_header("X-ACP-Agent", "BAPert")
        with urllib.request.urlopen(req, timeout=15) as r:
            payload = json.load(r)
        data = payload.get("data")
        rows = data.get("agents") if isinstance(data, dict) else data
        names = set()
        for row in rows or []:
            if isinstance(row, str):
                names.add(row)
            elif isinstance(row, dict) and row.get("name"):
                names.add(str(row["name"]))
        return names
    except Exception as e:
        print(f"[warn] roster unavailable ({e}) — cannot verify agent names")
        return set()


def agent_name_from_transcript(path: Path) -> str | None:
    """Whose session is this? Ask the transcript, don't decode the folder name.

    THE BUG THIS FIXES (2026-08-14): the agent name was taken from the project
    DIRECTORY SLUG — `C--Users-jon-local-AgentRepos-BAPert` — and stored as the
    kb scope_id. Boot looks up `BAPert`. Exact match, so every summary ever
    written by this script was unreadable, and every boot logged `summary=none`
    while the rig looked like it had a working summary pipeline.

    Claude records the real `cwd` in the transcript, and the ACP spawns each
    agent in a directory named for it, so the basename of that cwd IS the agent
    name — read from the runtime rather than reconstructed from a slug that was
    lossy on purpose.
    """
    try:
        with path.open(encoding="utf-8", errors="ignore") as f:
            for i, line in enumerate(f):
                if i > 50:
                    break
                line = line.strip()
                if not line:
                    continue
                try:
                    entry = json.loads(line)
                except json.JSONDecodeError:
                    continue
                cwd = entry.get("cwd")
                if cwd:
                    return Path(str(cwd).replace("\\", "/")).name
    except Exception as e:
        print(f"[warn] could not read cwd from {path.name}: {e}")
    return None


def is_degenerate(text: str) -> bool:
    """Did the local model produce garbage instead of a handoff?

    DotNetPert-Scout's first run came back as a line of '@@@@@@@@@@'. A summary
    like that is WORSE than none: the boot prompt presents it as "where you left
    off", so the agent starts believing it has context and has nothing. Reject
    it — an empty summary is honest, garbage is not.
    """
    body = "".join(ch for ch in text if not ch.isspace())
    if len(body) < 40:
        return True
    # A real handoff is mostly letters and digits.
    alnum = sum(1 for ch in body if ch.isalnum())
    if alnum / len(body) < 0.55:
        return True
    # Any single character dominating is the classic repetition collapse.
    if max(body.count(ch) for ch in set(body)) / len(body) > 0.30:
        return True
    return False


def distill_transcript(raw: str, max_chars: int = 24000) -> str:
    """Raw jsonl -> readable conversation tail.

    Keeps role, message text, and tool NAMES (not their payloads — a 40KB file
    read tells the summariser nothing that `<used Read>` doesn't). Returns the
    LAST `max_chars` worth, because what an agent needs on resume is where it
    got to, not how it started.
    """
    parts = []
    for line in raw.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            entry = json.loads(line)
        except json.JSONDecodeError:
            continue
        msg = entry.get("message") or {}
        role = msg.get("role")
        if role not in ("user", "assistant"):
            continue
        content = msg.get("content")
        if isinstance(content, str):
            text = content.strip()
        else:
            chunks = []
            for block in content or []:
                if not isinstance(block, dict):
                    continue
                btype = block.get("type")
                if btype == "text":
                    chunks.append(block.get("text", ""))
                elif btype == "tool_use":
                    chunks.append(f"<used {block.get('name')}>")
                elif btype == "tool_result":
                    chunks.append("<tool result>")
                # thinking blocks are deliberately dropped
            text = "\n".join(c for c in chunks if c).strip()
        if not text:
            continue
        # Bound any single message so one giant paste can't eat the window.
        if len(text) > 2000:
            text = text[:2000] + " …"
        parts.append(f"{role.upper()}: {text}")

    convo = "\n\n".join(parts)
    if len(convo) > max_chars:
        convo = "[… earlier turns omitted …]\n\n" + convo[-max_chars:]
    return convo


def started_project_id() -> int | None:
    """The project this rig was started on, or None.

    A summary is read back at boot as RESUME context, so one stored without a
    project is not merely untidy — it becomes the marching orders of whichever
    project starts next. Agents sit on several project teams at once (18 and 31
    share six of them today), so that is the ordinary case, not an edge case.

    Returns None rather than guessing. Every caller must treat None as "store
    nothing": an unscoped summary is worse than a missing one, because a missing
    one costs a cold start and an unscoped one costs a wrong day.

    SAME ORDERING TRAP AS live_roster(): this runs at shutdown, and the ACP API
    is one of the things shutting down. The env override exists so a caller that
    already knows the project can say so and not depend on the API outliving it.
    """
    override = os.environ.get("SUMMARY_PROJECT_ID", "").strip()
    if override:
        if not override.isdigit():
            print(f"[warn] SUMMARY_PROJECT_ID={override!r} is not an integer — ignoring it")
        else:
            print(f"[project] {override} from SUMMARY_PROJECT_ID (API not consulted)")
            return int(override)

    try:
        req = urllib.request.Request(f"{ACP_API}/v1/projects/current")
        req.add_header("X-ACP-Agent", "BAPert")
        with urllib.request.urlopen(req, timeout=15) as r:
            payload = json.load(r)
        pid = ((payload.get("data") or {}).get("project") or {}).get("id")
        if isinstance(pid, int) and pid > 0:
            print(f"[project] {pid} from {ACP_API}/v1/projects/current")
            return pid
        print("[warn] no project started (nothing was engaged) — storing nothing")
        return None
    except Exception as e:
        print(f"[warn] could not read the started project ({e}) — storing nothing. "
              f"Re-run with SUMMARY_PROJECT_ID=<id> if you know it.")
        return None


def find_agent_transcripts() -> dict:
    """Find agent session transcripts in ~/.claude/projects/, keyed by AGENT NAME."""
    transcripts = {}
    projects_dir = Path.home() / ".claude" / "projects"

    if not projects_dir.exists():
        print(f"[info] No projects dir found at {projects_dir}")
        return transcripts

    roster = live_roster()
    if roster:
        print(f"[roster] {len(roster)} agents: {', '.join(sorted(roster))}")
    else:
        print("[warn] no roster — storing nothing (a summary under a wrong key is unreadable)")
        return transcripts

    for project_dir in projects_dir.iterdir():
        if not project_dir.is_dir():
            continue

        jsonl_files = list(project_dir.glob("**/*.jsonl"))
        if not jsonl_files:
            continue

        latest_jsonl = max(jsonl_files, key=lambda p: p.stat().st_mtime)
        agent_name = agent_name_from_transcript(latest_jsonl)

        if not agent_name or agent_name not in roster:
            continue

        # Same agent in two project dirs (a second-instance cwd): keep the
        # transcript that was written most recently.
        prev = transcripts.get(agent_name)
        if prev and prev[1] >= latest_jsonl.stat().st_mtime:
            continue

        try:
            content = latest_jsonl.read_text(errors="ignore")
            transcripts[agent_name] = (content, latest_jsonl.stat().st_mtime)
            print(f"[found] {agent_name}: {len(content)} bytes ({project_dir.name})")
        except Exception as e:
            print(f"[error] Reading {agent_name} transcript: {e}")

    return {name: payload[0] for name, payload in transcripts.items()}


def cleanup_old_summaries(agent_name: str, project_id: int) -> None:
    """Retire this agent's previous summary FOR THIS PROJECT ONLY.

    THE project_id PREDICATE IS LOad-BEARING, not tidiness. Without it, shutting
    down project 31 expires the agent's project-18 summary too — so the fix for
    cross-project bleed would itself destroy the other project's continuity, and
    silently, because expiry is invisible until the next boot comes up cold.
    """
    ssh_cmd = ('ssh -i ~/.ssh/dotnetpert_93 dotnetpert@10.0.0.93 '
               '"sudo docker exec -i kb-postgres psql -U kb -d kb -v ON_ERROR_STOP=1 -tA"')
    # Mark old summaries as expired so they don't clutter queries
    sql = (
        f"UPDATE kb SET expires_at = now() "
        f"WHERE scope = 'agent' AND scope_id = '{agent_name}' "
        f"AND project_id = {int(project_id)} "
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


def store_summary_in_kb(agent_name: str, full_summary: str, token_estimate: int,
                        project_id: int) -> bool:
    """Store ONE session summary, scoped to the project it came from.

    ONE ROW, NOT TWO (2026-08-14). This used to write a "(full)" dump and a
    "(short)" boot summary. Measured on the 7-agent shutdown that day: the two
    rows were the SAME TEXT, differing only by a 127-character trailer appended
    to the short one telling the reader the full session was available in the kb
    — a pointer to detail that did not exist. They diverged only when a summary
    exceeded MAX_SHORT_TOKENS, which it never did.

    The duplicate was not merely waste. Nothing ever read the "(full)" row —
    sessionSummary.ts matches the short title only — while kb recall returns a
    handful of slots per query, so two of them went to identical text for every
    agent, permanently crowding out other memories.

    SCOPED TO A PROJECT. An unscoped summary is read back as resume context by
    whichever project starts next; see started_project_id().
    """
    # One tier now, so one ceiling. Trim from the END on a line boundary: the
    # "what to do next" lives at the end of the handoff, and the old lines[:10]
    # chop threw exactly that away.
    MAX_SUMMARY_TOKENS = 1200

    if not full_summary or not full_summary.strip():
        print(f"[skip] Empty summary for {agent_name}")
        return False

    if is_degenerate(full_summary):
        print(f"[reject] {agent_name} summary is degenerate model output — storing nothing")
        return False

    if not KB_REMEMBER.exists():
        print(f"[error] kb_remember.py not found at {KB_REMEMBER}")
        return False

    # Retire this agent's previous summary FOR THIS PROJECT ONLY.
    cleanup_old_summaries(agent_name, project_id)

    # Boot summary. This used to keep `lines[:10]` — the first ten lines of the
    # handoff — which sliced BAPert's mid-sentence at "In-Progress Tasks:" and
    # threw away the half that says what to do next.
    #
    # The 300-token ceiling came from the context-size panic. The measured win
    # turned out to be TURN elimination, not per-turn size (77x), and startups
    # are now fresh sessions rather than replayed transcripts — so a boot
    # summary is landing in an empty window, not a full one. Jon 2026-08-14:
    # "the session summarizer needn't be quite so sparse now." Keep the whole
    # handoff when it fits; trim from the END on a line boundary when it does
    # not, because the "what next" lives at the end.
    short_summary = full_summary.strip()
    if estimate_tokens(short_summary) > MAX_SUMMARY_TOKENS:
        limit = MAX_SUMMARY_TOKENS * 4  # ~4 chars/token
        cut = short_summary[:limit]
        nl = cut.rfind('\n')
        short_summary = (cut[:nl] if nl > limit // 2 else cut) + "\n[… trimmed]"

    # NO "the full session is in the kb" TRAILER. There is no second row to
    # point at any more, and there never usefully was — the pointer sent agents
    # to spend a turn fetching text identical to what they were already holding.

    # The ONE row. Title carries no tier word: there is one summary per agent
    # per project, and sessionSummary.ts matches this title exactly.
    try:
        cmd = [
            "python", str(KB_REMEMBER),
            "--title", f"{agent_name} session summary",
            "--scope", "agent",
            "--id", agent_name,
            "--project", str(int(project_id)),
            "--source", f"shutdown-with-summaries.py (Qwen 2.5, project {project_id})",
        ]
        proc = subprocess.run(
            cmd,
            input=short_summary.encode(),
            capture_output=True,
            timeout=30
        )
        if proc.returncode == 0:
            short_tokens = estimate_tokens(short_summary)
            print(f"[stored] {agent_name} summary in kb ({short_tokens} tokens, project {project_id})")
            return True
        else:
            print(f"[error] kb_remember failed for {agent_name}: {proc.stderr.decode()}")
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

            # Resolve the project BEFORE spending minutes of local-model time on
            # summaries we would then have to throw away. An unscoped summary is
            # not a lesser summary, it is a hazard: the next project to start
            # reads it as its own resume context.
            project_id = started_project_id()
            if project_id is None:
                print("[abort] no project id — refusing to store unscoped summaries. "
                      "Agents will boot cold, which is the safe failure.")
                transcripts = {}
            else:
                transcripts = find_agent_transcripts()

            if transcripts:
                stored = 0
                rejected = 0
                for agent_name, transcript in transcripts.items():
                    print(f"[summarize] {agent_name}...")
                    summary, token_estimate = summarize_with_qwen(transcript, agent_name)
                    if summary:
                        if store_summary_in_kb(agent_name, summary, token_estimate, project_id):
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
