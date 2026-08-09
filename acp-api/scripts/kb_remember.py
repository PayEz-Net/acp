#!/usr/bin/env python3
"""Write a memory into the shared kb store on 93. The replacement for adding a
file under memory/ plus a line in MEMORY.md.

  python kb_remember.py --title "..." --scope standard --id feedback --source "..." <<'EOF'
  <the memory body>
  EOF

  --scope   agent | project | standard          (kb_scope enum)
  --id      BAPert | 31 | feedback | verification | ...
  --source  where this came from — REQUIRED, a memory with no provenance is a rumour

Idempotent: content_sha is computed IN the insert, so re-running updates rather
than duplicating. (NULLs are DISTINCT under UNIQUE in Postgres, so a sha filled
in by a later UPDATE would give no dedupe at all.)

Refuses to store anything that looks like a credential — kb is LAN-readable by
every agent, which is a wider blast radius than a file on one machine.
"""
import argparse, hashlib, json, os, re, subprocess, sys, tempfile, urllib.request

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
    p.add_argument("--title", required=True)
    p.add_argument("--scope", required=True, choices=["agent", "project", "standard"])
    p.add_argument("--id", required=True, dest="scope_id")
    p.add_argument("--source", required=True)
    p.add_argument("--body", default=None, help="omit to read from stdin")
    p.add_argument("--ttl", default=None, metavar="30d|48h",
                   help="make this a QUICK NOTE that stops being retrieved after "
                        "this long. Omit for a PERMANENT memory (doctrine, "
                        "references, earned facts). Expired notes are kept, "
                        "never deleted.")
    a = p.parse_args()

    # Durability is decided HERE, at write time, while the author still knows
    # whether this is doctrine or a reminder. Nobody ever goes back and
    # retro-classifies, which is why there is no "mark it stale later" path.
    expires_sql = "NULL"
    if a.ttl:
        m = re.fullmatch(r"(\d+)([dh])", a.ttl.strip().lower())
        if not m:
            sys.exit(f"--ttl must look like 30d or 48h, got {a.ttl!r}")
        n, unit = int(m.group(1)), m.group(2)
        expires_sql = f"now() + interval '{n} {'days' if unit == 'd' else 'hours'}'"

    body = a.body if a.body is not None else sys.stdin.read()
    body = body.strip()
    if not body:
        sys.exit("empty memory body")

    for pat in SECRET_PATTERNS:
        if re.search(pat, body):
            sys.exit(f"REFUSED: body matches a credential pattern ({pat}). "
                     "kb is readable by every agent — keep secrets out of it.")

    # The chunk must stand alone at retrieval time: it is returned without its
    # neighbours, so the title has to be inside the text too.
    chunk = f"{a.title}\n\n{body}"
    sha = hashlib.sha256(chunk.encode()).hexdigest()
    vec = "[" + ",".join(f"{x:.6f}" for x in embed(chunk)) + "]"

    sql = (
        "INSERT INTO kb (scope, scope_id, title, chunk, source, embedding, content_sha, expires_at) "
        f"VALUES ({q(a.scope)}::kb_scope, {q(a.scope_id)}, {q(a.title)}, {q(chunk)}, "
        f"{q(a.source)}, {q(vec)}::vector, {q(sha)}, {expires_sql}) "
        "ON CONFLICT (content_sha) DO UPDATE SET scope=EXCLUDED.scope, "
        "scope_id=EXCLUDED.scope_id, title=EXCLUDED.title, source=EXCLUDED.source, "
        "embedding=EXCLUDED.embedding, expires_at=EXCLUDED.expires_at, updated_at=now() "
        "RETURNING id, (xmax = 0) AS inserted, "
        "coalesce(to_char(expires_at,'YYYY-MM-DD'),'permanent') AS life;\n")

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
    # psql prints its own `INSERT 0 1` command tag on stdout after the RETURNING
    # row, so split the FIRST LINE only — parsing the whole buffer glues the tag
    # onto the last field and silently mislabels every write.
    lines = [ln for ln in r.stdout.strip().splitlines() if "|" in ln]
    out = lines[0] if lines else ""
    parts = out.split("|")
    rid = parts[0] if parts else "?"
    inserted = parts[1] if len(parts) > 1 else "?"
    life = parts[2] if len(parts) > 2 else "?"
    print(f"kb {'INSERTED' if inserted == 't' else 'UPDATED'} id={rid} "
          f"scope={a.scope}/{a.scope_id} "
          f"{'PERMANENT' if life == 'permanent' else 'NOTE, expires ' + life} "
          f"title={a.title!r}")


if __name__ == "__main__":
    main()
