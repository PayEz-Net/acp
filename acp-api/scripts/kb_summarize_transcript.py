#!/usr/bin/env python3
"""Summarise an agent's session transcript with the local model, for kb storage.

  python kb_summarize_transcript.py --agent BAPert [--session <id>] \
    | python kb_session_summary.py --agent BAPert --session <id> --stamp <iso>

Prints the summary to STDOUT and stores nothing. Composable on purpose: a human
or a calling script decides whether it is worth keeping, and the same text can be
reviewed before it becomes an agent's boot context.

WHY A LOCAL MODEL AND NOT THE AGENT ITSELF
  An agent writing its own summary is higher quality — it knows intent, what it
  abandoned, what it never got to. But sessions die without warning (crash,
  shutdown, OOM), and the summaries most worth having are exactly the ones from
  sessions that ended badly. This reads the transcript off disk afterwards, so it
  survives the session that produced it, and it works for KIMI as well as Claude
  because it hooks no runtime.

  Use both: agent-authored when there is a chance, this as the floor. --source
  records which, because "BAPert wrote this" and "a 7B model inferred it from a
  transcript" deserve different trust at boot and a reader cannot otherwise tell.

NOT A LIVENESS SIGNAL
  Transcript bytes do not track work — Claude Code writes an entry when a turn
  COMPLETES, so a long tool sequence looks identical to a wedge. Never trigger
  this off "transcript went quiet"; it will summarise agents mid-thought.
"""
import argparse
import glob
import json
import os
import sys
import urllib.request

OLLAMA = os.environ.get("KB_OLLAMA_URL", "http://10.0.0.220:11434")
MODEL = os.environ.get("KB_SUMMARY_MODEL", "qwen2.5-coder:7b")
PROJECTS = os.path.join(os.path.expanduser("~"), ".claude", "projects")

# Enough to see how the session ended without paying for the whole thing. The
# tail is what matters at boot: state, not history.
TAIL_TURNS = 60
MAX_TEXT = 14000

PROMPT = """You are writing a handoff note for an AI agent that is about to boot and \
resume this work. Read the session transcript below.

Output EXACTLY these three sections, nothing else. No preamble, no markdown headers \
beyond the labels, no praise, no summary of the summary.

STATE: what is true now. What was built, changed, deployed, or proven. Name files, \
branches, commits, ids, endpoints VERBATIM.
NEXT: the single next action, concretely. If there is no obvious next action, say so.
BLOCKERS: what is stopping progress, or "none".

Rules:
- Be terse. Under 200 words total.
- Facts only. If the transcript does not establish something, leave it out.
- Do NOT invent file paths, commit hashes or numbers. Copy them or omit them.
- Prefer what would change the next decision over what happened chronologically.

TRANSCRIPT:
"""


def find_transcript(session, project_dir):
    root = os.path.join(PROJECTS, project_dir) if project_dir else None
    if root and not os.path.isdir(root):
        sys.exit(f"no such project dir: {root}")
    search = [root] if root else [
        d for d in glob.glob(os.path.join(PROJECTS, "*")) if os.path.isdir(d)]
    hits = []
    for d in search:
        hits.extend(glob.glob(os.path.join(d, "*.jsonl")))
    if session:
        hits = [h for h in hits if session in os.path.basename(h)]
        if not hits:
            sys.exit(f"no transcript found for session {session}")
    if not hits:
        sys.exit("no transcripts found")
    return max(hits, key=os.path.getmtime)


def extract(path):
    """Pull the human-readable conversation out; tool payloads are noise here."""
    turns = []
    for ln in open(path, encoding="utf-8", errors="replace"):
        try:
            r = json.loads(ln)
        except Exception:
            continue
        if r.get("type") not in ("user", "assistant"):
            continue
        msg = r.get("message") or {}
        content = msg.get("content")
        if isinstance(content, str):
            text = content
        elif isinstance(content, list):
            text = " ".join(
                b.get("text", "") for b in content
                if isinstance(b, dict) and b.get("type") == "text")
        else:
            continue
        text = text.strip()
        if not text:
            continue
        turns.append(f"[{r['type'].upper()}] {text}")
    return turns


def summarise(text):
    req = urllib.request.Request(
        f"{OLLAMA}/api/generate",
        data=json.dumps({
            "model": MODEL,
            "prompt": PROMPT + text,
            "stream": False,
            # Deterministic-ish: a handoff that changes wording every run is
            # impossible to diff against the previous one.
            "options": {"temperature": 0.2, "num_predict": 400},
        }).encode(),
        headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=300) as r:
        return json.load(r).get("response", "").strip()


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--agent", required=True)
    p.add_argument("--session", default=None, help="session id; default = newest transcript")
    p.add_argument("--project-dir", default=None,
                   help="dir name under ~/.claude/projects, e.g. E--Repos")
    a = p.parse_args()

    path = find_transcript(a.session, a.project_dir)
    turns = extract(path)
    if not turns:
        sys.exit(f"transcript {os.path.basename(path)} has no readable turns")

    text = "\n\n".join(turns[-TAIL_TURNS:])[-MAX_TEXT:]
    out = summarise(text)
    if not out:
        sys.exit("model returned nothing — refusing to emit an empty summary")

    print(out)
    print(f"\n(machine-generated by {MODEL} from "
          f"{os.path.basename(path)}, last {min(TAIL_TURNS, len(turns))} turns)",
          file=sys.stderr)


if __name__ == "__main__":
    main()
