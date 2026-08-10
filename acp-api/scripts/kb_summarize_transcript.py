#!/usr/bin/env python3
"""Summarise an agent's session transcript with the local model, for kb storage.

  python kb_summarize_transcript.py --agent BAPert [--session <id>] \
    | python kb_session_summary.py --agent BAPert --session <id> --stamp <iso>

Prints the summary to STDOUT and stores nothing. Exits NON-ZERO and prints
nothing when the summary cannot be trusted — nothing is strictly better than
plausible garbage in an agent's boot context, because the agent has no way to
doubt it.

WHY A LOCAL MODEL AND NOT THE AGENT ITSELF
  An agent writing its own summary is higher quality — it knows intent, what it
  abandoned, what it never got to. But sessions die without warning (crash,
  shutdown, OOM), and the summaries most worth having are exactly the ones from
  sessions that ended badly. This reads the transcript off disk afterwards, so
  it survives the session that produced it, and it works for KIMI as well as
  Claude because it hooks no runtime.

THE FAILURE THIS FILE EXISTS TO PREVENT (measured 2026-08-09)
  First version was validated on ONE transcript — mine — whose tail was dense
  with real identifiers. It returned a real branch and a real commit, so it was
  trusted. Run against seven team transcripts whose tails were mail-ID noise,
  it produced `Commits: abc123, def456, ghi789` — invented placeholder hashes,
  under a prompt that explicitly forbade inventing hashes. Placeholder hashes
  are the worst possible output because they LOOK like data and survive review.

  ONE PASSING SAMPLE IS NOT A VALIDATED TOOL. So the model no longer gets to be
  trusted: every identifier it emits is checked against the transcript, and a
  summary that cites anything not present is REJECTED rather than cleaned up.
  A cleaned-up hallucination is still a summary written by something that
  hallucinates.

NOT A LIVENESS SIGNAL
  Transcript bytes do not track work — Claude Code writes an entry when a turn
  COMPLETES, so a long tool sequence looks identical to a wedge. Never trigger
  this off "transcript went quiet"; it will summarise agents mid-thought.
"""
import argparse
import glob
import json
import os
import re
import sys
import urllib.request

OLLAMA = os.environ.get("KB_OLLAMA_URL", "http://10.0.0.220:11434")
MODEL = os.environ.get("KB_SUMMARY_MODEL", "qwen2.5-coder:7b")
PROJECTS = os.path.join(os.path.expanduser("~"), ".claude", "projects")

TAIL_TURNS = 60
MAX_TEXT = 14000

# Identifier shapes the model must never originate. Anything matching these in
# the OUTPUT has to appear verbatim in the transcript or the summary is void.
VERIFY_PATTERNS = [
    (re.compile(r"\b[0-9a-f]{6,40}\b"), "commit-like hash"),
    (re.compile(r"\b[A-Za-z0-9_.-]+/[A-Za-z0-9_./-]+\.[A-Za-z]{2,4}\b"), "file path"),
    (re.compile(r"\b[A-Za-z0-9_.-]+\\[A-Za-z0-9_.\\-]+\.[A-Za-z]{2,4}\b"), "file path"),
]
# Words that match a hash pattern but are ordinary English or obvious filler.
HASH_ALLOW = {"added", "abcdef", "decade", "facade", "accede", "efface", "deface"}

PROMPT = """You are writing a handoff note for an AI agent that is about to boot and \
resume this work. Read the session transcript below.

Output EXACTLY these three sections, nothing else. No preamble, no markdown \
bold, no summary of the summary.

STATE: what is true now. What was built, changed, deployed, or proven.
NEXT: the single next action, concretely.
BLOCKERS: what is stopping progress, or "none".

HARD RULES — a summary that breaks any of these is discarded entirely:
- Under 200 words.
- Every commit hash, file path, branch name and identifier you write MUST appear \
VERBATIM in the transcript. Copy them character for character.
- If you cannot find a real one, WRITE NOTHING for that item. Do not write a \
placeholder. Do not write abc123, def456, foo.ts, or any example value. An \
omission is correct; an invented value is a lie the next agent will act on.
- Do not list bare numeric ids with no explanation of what they are.
- If the transcript does not establish what the session accomplished, say \
exactly: "Transcript does not establish session state." and nothing else.

TRANSCRIPT:
"""


def note(msg):
    print(f"[summarise] {msg}", file=sys.stderr)


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
        if text:
            turns.append(f"[{r['type'].upper()}] {text}")
    return turns


def summarise(text):
    req = urllib.request.Request(
        f"{OLLAMA}/api/generate",
        data=json.dumps({
            "model": MODEL,
            "prompt": PROMPT + text,
            "stream": False,
            "options": {"temperature": 0.1, "num_predict": 400},
        }).encode(),
        headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=300) as r:
        return json.load(r).get("response", "").strip()


def verify(summary, haystack):
    """Return a list of fabrications. Empty list = every identifier checks out.

    Deliberately a REJECTER, not a sanitiser. Stripping the invented hashes and
    keeping the rest would leave prose written by something demonstrably
    willing to invent — the remaining sentences are not more trustworthy just
    because the obvious tells were removed.
    """
    bad = []
    for pattern, kind in VERIFY_PATTERNS:
        for tok in set(pattern.findall(summary)):
            if tok.lower() in HASH_ALLOW:
                continue
            if tok not in haystack:
                bad.append(f"{kind} {tok!r} does not appear in the transcript")
    return bad


def substantive(summary):
    """Reject summaries that technically parse but carry no state."""
    if "Transcript does not establish session state" in summary:
        return False
    body = re.sub(r"(?i)\b(state|next|blockers)\b\s*:?", " ", summary)
    body = re.sub(r"(?i)\bnone( explicitly mentioned)?\.?", " ", body)
    body = re.sub(r"[^A-Za-z0-9]+", " ", body).strip()
    return len(body.split()) >= 12


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--agent", required=True)
    p.add_argument("--session", default=None)
    p.add_argument("--project-dir", default=None)
    a = p.parse_args()

    path = find_transcript(a.session, a.project_dir)
    turns = extract(path)
    if not turns:
        note(f"{os.path.basename(path)} has no readable turns — nothing written")
        sys.exit(2)

    text = "\n\n".join(turns[-TAIL_TURNS:])[-MAX_TEXT:]
    out = summarise(text)
    if not out:
        note("model returned nothing — nothing written")
        sys.exit(2)

    # Verify against the WHOLE transcript, not just the tail fed to the model:
    # an identifier from earlier in the session is real even if it was not in
    # the excerpt, and rejecting it would punish accuracy.
    whole = "\n".join(turns)
    fabrications = verify(out, whole)
    if fabrications:
        note("REJECTED — the model cited things that are not in the transcript:")
        for f in fabrications:
            note(f"  {f}")
        sys.exit(3)

    if not substantive(out):
        note("REJECTED — no state established; nothing is better than a summary "
             "that says nothing happened")
        sys.exit(4)

    print(out)
    note(f"ok: {os.path.basename(path)}, last {min(TAIL_TURNS, len(turns))} turns, "
         f"all identifiers verified against transcript")


if __name__ == "__main__":
    main()
