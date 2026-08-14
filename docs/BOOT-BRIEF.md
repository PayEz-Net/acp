# Boot Brief (local qwen)

One mail to BAPert at rig start: a local qwen2.5-coder:7b summarizes the kanban
board + BAPert's 25 most recent mails into five fixed sections (State of the
board / Needs Jon / Move first / Stranded risk / FYI) and self-mails it as
**BOOT BRIEF — session start**.

## Run it

```bash
bash scripts/brief/bootbrief.sh [state-dir]   # right after the rig is up
```

Waits up to 3 min for `127.0.0.1:3001`, skips if a BOOT BRIEF went out in the
last 30 min (restart de-dupe), then fetches, summarizes, sends.

## Rules it lives by

- **Advise, never withhold** (Jon 2026-08-14): all mail still flows to BAPert
  normally. The brief is an extra layer; if qwen is down or the answer is
  malformed, **nothing is sent** — a failed brief must never read as "all
  clear".
- No mechanical grep-bucketing — the model reads real subjects + body snippets
  and writes the summary. Bash only fetches and shapes the corpus.
- Free to run: local Ollama only. Env overrides: `ACP_API`, `OLLAMA`,
  `BOOTBRIEF_MODEL`.

Known limits (v1, measured on first live send): Stranded-risk can pattern-match
wrong when the corpus lacks merge evidence; card titles are truncated at 110
chars; "State of the board" restates counts rather than interpreting them.
Tighten the prompt or widen the corpus if these bite.

Log: `<state-dir>/bootbrief.log`.
