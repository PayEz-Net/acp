#!/usr/bin/env python3
"""Write an agent's end-of-session summary into the kb store on 93.

  python kb_session_summary.py --agent BAPert --session <id> [--ttl 14d] < summary.md

This is the WRITE half of session continuity (see
docs/RESEARCH-SESSION-CONTINUITY-ON-BOOT-20260810.md). The read half — injecting
the latest summary into GET /v1/agents/:name/profile — is gated on acp-api having
a real `kb` connection, and is deliberately not built here.

Useful on its own: the kb_recall hook already retrieves these when a later prompt
is relevant, so summaries pay off before boot-injection exists.

WHAT A SUMMARY IS
  State, next action, open blockers. NOT a narrative of what happened.
  At boot an agent needs to know where things stand and what to do next; the
  story of how it got there costs context and changes no decision.

WHY --ttl DEFAULTS TO 14 DAYS AND CANNOT BE DISABLED
  The 8 pre-existing handoff_* memories were written permanent and were still
  being retrieved five months later, describing a world that no longer existed.
  A session summary with no expiry is a landmine. Expired is not deleted — the
  row stays queryable for anyone reconstructing what happened.
"""
import argparse
import hashlib
import json
import os
import re
import subprocess
import sys
import tempfile
import urllib.request

OLLAMA = os.environ.get("KB_OLLAMA_URL", "http://10.0.0.220:11434")
SSH = ('ssh -i ~/.ssh/dotnetpert_93 dotnetpert@10.0.0.93 '
       '"sudo docker exec -i kb-postgres psql -U kb -d kb -v ON_ERROR_STOP=1 -tA -f -"')

SECRET_PATTERNS = [
    r"-----BEGIN [A-Z ]*PRIVATE KEY-----",
    r"\bsk-[A-Za-z0-9]{20,}",
    r"\bghp_[A-Za-z0-9]{20,}",
    r"\bxox[baprs]-[A-Za-z0-9-]{10,}",
    r"(?i)\b(password|passwd|client_secret|api[_-]?key|secret)\s*[:=]\s*\S{8,}",
]

# A summary that grows into a narrative taxes every boot the agent ever runs.
MAX_CHARS = 4000


def embed(text):
    req = urllib.request.Request(
        f"{OLLAMA}/api/embeddings",
        data=json.dumps({"model": "nomic-embed-text", "prompt": text[:4000]}).encode(),
        headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=60) as r:
        v = json.load(r)["embedding"]
    if len(v) != 768:
        sys.exit(f"embedding dim {len(v)} != 768 — wrong model")
    return v


def q(s):
    return "'" + s.replace("'", "''") + "'"


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--agent", required=True, help="agent name, e.g. BAPert")
    p.add_argument("--session", required=True, help="session id — provenance, not decoration")
    p.add_argument("--stamp", required=True,
                   help="ISO timestamp for the summary. Passed in, never generated here, "
                        "so the caller owns the clock and the value is reproducible.")
    p.add_argument("--project", default=None, help="project id, if the work was project-scoped")
    p.add_argument("--ttl-days", type=int, default=14)
    a = p.parse_args()

    body = sys.stdin.read().strip()
    if not body:
        sys.exit("empty summary — nothing written (an empty summary is worse than none: "
                 "it reads at boot as 'nothing happened')")
    if len(body) > MAX_CHARS:
        sys.exit(f"summary is {len(body)} chars, limit {MAX_CHARS}. Cut it to state + "
                 "next action + blockers; this is injected at boot, not archived.")

    for pat in SECRET_PATTERNS:
        if re.search(pat, body):
            sys.exit(f"REFUSED: matches a credential pattern ({pat}). kb is readable by "
                     "every agent.")

    title = f"{a.agent} session summary {a.stamp[:10]}"
    # The staleness warning is IN the chunk, not wrapped around it at read time:
    # whatever surface injects this later, the caveat travels with the text.
    header = (f"SESSION SUMMARY — {a.agent}, as of {a.stamp}"
              + (f", project {a.project}" if a.project else "")
              + ".\nPOINT-IN-TIME. Other agents and deploys have moved since. "
                "Verify any file:line, branch or status here against the live system "
                "before acting on it.\n\n")
    chunk = f"{title}\n\n{header}{body}"
    sha = hashlib.sha256(chunk.encode()).hexdigest()
    vec = "[" + ",".join(f"{x:.6f}" for x in embed(chunk)) + "]"

    sql = (
        "INSERT INTO kb (scope, scope_id, title, chunk, source, embedding, content_sha, expires_at) "
        f"VALUES ('agent'::kb_scope, {q(a.agent)}, {q(title)}, {q(chunk)}, "
        f"{q(f'{a.agent} session {a.session}, {a.stamp}')}, {q(vec)}::vector, {q(sha)}, "
        f"now() + interval '{a.ttl_days} days') "
        "ON CONFLICT (content_sha) DO UPDATE SET expires_at=EXCLUDED.expires_at, "
        "updated_at=now() "
        "RETURNING id;\n")

    fd, path = tempfile.mkstemp(suffix=".sql")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(sql)
        r = subprocess.run(f'cat "{path}" | {SSH}', shell=True,
                           capture_output=True, text=True, encoding="utf-8")
    finally:
        os.unlink(path)

    if r.returncode:
        sys.exit(f"kb write FAILED: {r.stderr.strip()[:400]}")
    rid = next((ln for ln in r.stdout.strip().splitlines() if ln.strip().isdigit()), "?")
    print(f"kb session summary stored id={rid} agent={a.agent} "
          f"expires in {a.ttl_days}d")


if __name__ == "__main__":
    main()
