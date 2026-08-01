# Terminal replay / session-resume provenance — audit + recommendation

**Auditor:** InsightPert (external) · **Date:** 2026-08-01 · **Status:** PROBLEM CONFIRMED, cross-machine

## Measured finding

Sampled the newest stored terminal session for each of 5 agents under
project 18 (ACP_SEO_Edition) via `/v1/terminal/replay`:

| Agent | Terminal | Newest snapshot | Foreign content |
|---|---|---|---|
| NextPert | 176afafe | 2026-07-31T23:00Z | `E:\`, `PS E:`, Windows PowerShell |
| Aurum | a66ca67f | 2026-07-31T22:48Z | same |
| BAPert | 1d5d3cd6 | 2026-07-31T18:26Z | same |
| DotNetPert | 04e63184 | 2026-07-31T18:26Z | same |
| QAPert | dddf6e56 | 2026-07-31T13:29Z | same |

**5/5 newest sessions under a Mac project contain Windows-machine terminal
content.** All snapshots are exactly 52 lines (fixed window, batched writer).
The cloud terminal store does not segregate by machine, and sessions of
same-named agents on two machines interleave.

## Why it costs (demonstrated tonight, not hypothetical)

1. **BAPert wedge**: resumed session 41e19dc0 had the Windows PayEz thread
   injected as prompts; he processed ~6 foreign mails to `end_turn` and
   produced nothing until SIGTERM.
2. **Aurum identity scramble**: resumed session 2beccbc9 contained captain
   mails sent under his own badge (routing mistake); he concluded he was the
   external captain, disavowed the sprint reset (14947), and the team spent
   an hour flip-flopping on which announcement was real.
3. Both required human intervention (Jon) to stop sessions — the most
   expensive unstick there is.

## Recommendations

1. **Machine-scope the terminal/session store at write and read.** A device
   id on every snapshot; replay and session-load filter by it. Same fix
   family as the per-instance current-project pointer (Windows task #5) —
   one account, two machines, everything per-user interleaves.
2. **Resume must verify provenance before loading** (machine + project), and
   REFUSE LOUDLY on mismatch — same doctrine as tonight's Start-gate:
   blocked and loud beats silent and wrong. A fresh spawn is cheaper than a
   contaminated resume.
3. **Resume should not inject the unread-mail tail blindly.** If the tail is
   cross-project flood, skip or summarize it. Tonight the resume prompt +
   flood was the wedge mechanism.
4. **Until fixed — operational rule**: on boot, the captain verifies each
   resumed agent's first output (ask it cwd/project; wrong answer →
   fresh-spawn, never resume). We did this by hand tonight; it works.

## Watch item

The 52-line uniform window suggests one batched snapshot writer (likely the
Windows side). Whoever owns the cloud terminal sync: that writer needs the
device id first — every other fix reads from what it writes.
