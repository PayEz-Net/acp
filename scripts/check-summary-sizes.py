#!/usr/bin/env python3
"""Check KB for oversized session summaries. Reports any that exceed 8000 chars (~2000 tokens)."""
import subprocess
import sys

SSH = ('ssh -i ~/.ssh/dotnetpert_93 dotnetpert@10.0.0.93 '
       '"sudo docker exec -i kb-postgres psql -U kb -d kb -tA"')

SQL = """
select scope_id as agent,
       length(chunk) as chars,
       round(length(chunk) / 4.0)::int as est_tokens,
       to_char(created_at, 'YYYY-MM-DD HH24:MI:SS') as stored_at
  from kb
 where scope = 'agent'
   and title like '%session summary%'
 order by created_at desc;
"""

MAX_CHARS = 8000
MAX_TOKENS = 2000

try:
    r = subprocess.run(
        SSH,
        shell=True,
        input=SQL,
        capture_output=True,
        text=True,
        timeout=10
    )
except Exception as e:
    print(f"[error] Failed to reach kb on 93: {e}")
    sys.exit(1)

if r.returncode != 0:
    print(f"[error] Query failed: {r.stderr.strip()[:200]}")
    sys.exit(1)

lines = r.stdout.strip().split('\n')
if not lines or not lines[0]:
    print("[info] No session summaries stored yet")
    sys.exit(0)

print(f"[found] {len(lines)} stored session summaries\n")

oversized = []
for line in lines:
    parts = line.split('|')
    if len(parts) < 4:
        continue
    agent, chars_str, tokens_str, stored_at = parts[0], parts[1], parts[2], parts[3]
    try:
        chars = int(chars_str)
        tokens = int(tokens_str)
    except ValueError:
        continue

    status = "OK" if chars <= MAX_CHARS else "OVERSIZED"
    print(f"  {agent:20} {chars:7} chars ({tokens:5} tokens) {status:10} {stored_at}")

    if chars > MAX_CHARS:
        oversized.append((agent, chars, tokens))

if oversized:
    print(f"\n[warning] {len(oversized)} summary(ies) exceed {MAX_CHARS} chars ({MAX_TOKENS} tokens):")
    for agent, chars, tokens in oversized:
        print(f"  - {agent}: {chars} chars ({tokens} tokens) → will be truncated at boot")
    print("\nThese will be auto-truncated when agents boot (defensive fallback).")
else:
    print(f"\n[ok] All summaries within safe limit")
