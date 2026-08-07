# Local-model spotter (watching the rig without burning the LLM account)

Origin (Jon, 2026-08-07): a kimi-based spotter watching the ACP log on a 5-min
cadence burned **103M cached-read tokens in two days** — the single largest
consumer on the account. Watching must not be the most expensive thing on the
rig. This pattern moves the watch to a **local model** (Ollama, zero account
tokens) by keeping the model's job tiny and the machinery dumb.

## Architecture

```
app log ──> spot.sh ──bash digest (grep counts, staleness, tail)──> small model verdict
              │                                                       │
              │                                            exactly one line:
              │                                            "OK: ..." / "ALERT: ..."
              ▼                                                       ▼
        no LLM call at all                              spotter-status.log (+ spotter-alert.txt on ALERT)
        when the log hasn't moved
```

Two rules make a 7B model reliable here:

1. **Bash does the measuring, the model does no measuring.** The script counts
   defers, zombie cancels, watchdog fires, restarts, 429s, and log staleness,
   and hands the model a compact digest plus the counters. Small models are
   bad at scanning 300 raw lines; they are fine at judging a digested summary
   against explicit rules.
2. **The verdict contract is one line.** `OK: ...` or `ALERT: ...`, first
   line only, validated by the script. Anything unparseable becomes an ALERT
   (fail loud, never fail silent — a blind spotter must say so).

## Files

- `scripts/spotter/spot.sh <app-log-path> [state-dir]` — one check. Idempotent
  quiet path: same log size as last run ⇒ `OK: no new output`, no model call.
- `scripts/spotter/spotloop.sh <app-log-path> [interval-s]` — the watch loop
  (default 300s). Run it as a background task next to the app.
- Verdicts: `<state-dir>/spotter-status.log`; alerts also append to
  `spotter-alert.txt`.

## Model choice

- **qwen2.5-coder:7b** (local Ollama) — current pick: free, fast, good enough
  for rule-based triage. Tested on live ACP logs 2026-08-07 (correctly flagged
  a mail-defer pile-up and passed a healthy boot).
- `minimax-m2:cloud` was considered and is **retired by Ollama** (API error).
- Any OpenAI-compatible endpoint works — `spot.sh` posts to
  `http://localhost:11434/v1/chat/completions`. A bigger local model can be
  swapped in by changing one line.

## Arming it for a run

```bash
# from the repo root, after the app is up:
bash scripts/spotter/spotloop.sh <path-to-app-output.log> 300
```

The app log is the `npm run dev:prod` console output. When launched from a
kimi background task it lives at
`~/.kimi-code/sessions/<wd>/session_*/agents/main/tasks/<task-id>/output.log`.

## What it watches for (rule set in spot.sh)

ALERT on: repeated restarts, repeated watchdog cancels, error loops, mail
deferring while agents are idle, unparseable/failed verdicts.
OK on: turns settling (`end_turn`), mail delivering, a single busy-rejection
followed by an immediate cancel (that is the designed resume-zombie cleanup,
not a fault), quiet logs, app shutdown.

Tuning rule of thumb: add to the bash counters FIRST, tighten the prompt rules
SECOND. Never ask the small model to find a pattern the script didn't count.
