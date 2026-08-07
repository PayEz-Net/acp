# Continuous Spotter — Phase 1: mechanical capture + filter (current, working)

**Status: shipped/working.** This is the non-agent-assisted spotter — a shell capture and a
narrow filter, no model in the loop. It caught the wedge, the mail-destruction bug, the 300s
watchdog kills, the Windows-path spawn deaths, and surfaced today's three fake-greens' context.
Phase 2 (agent-assisted) is a separate future doc: `agent_assisted_continous_spotter.md`.

> Origin: Mac-side working method (2026-08-05), moved into the repo so it's not re-derived.
> Canonical copy lives here now.

Three parts: **capture everything, alert on a narrow filter, then read the window — never the
line.** The third is the one that matters.

> **Prereq — pull `e96ac68` first (timestamps).** Every main-process line is stamped
> (`src/main/logTimestamps.ts`). Without it two adjacent lines may be 3ms or 3min apart with
> nothing to say which — a blind spot that caused a real misdiagnosis (a cancel that landed
> 2m41s into a productive turn read as an instant drop).

---

## 1. Capture

The main process logs to stdout and nothing persists it. You can't investigate what you didn't
record, and the interesting faults are the ones you notice an hour later.

**Windows (PowerShell) — this rig's actual start command (Jon):**
```powershell
npm run dev:prod 2>&1 | Tee-Object -FilePath .\acp-dev.log
```

**Mac/Linux:**
```bash
npm run dev:prod > dev.log 2>&1 &
```

(`dev:electron` also exists; `dev:prod` is the command Jon runs. Whichever you use, keep the
`2>&1 | Tee` so the spotter has a live log.)

`Tee-Object` writes and passes through, so you keep the console. **`2>&1` matters on both:**
adapter stderr carries the provider-throttle evidence (429/quota/backoff) — drop it and you lose
the distinction between **throttled** and **wedged**. The whole point is to *start it under this
capture* so the spotter has a live log to tail.

---

## 2. Alert on a narrow filter

Don't read the log — tail it through a filter that only emits lines you'd act on.

**Windows:**
```powershell
Get-Content .\acp-dev.log -Wait -Tail 0 | Select-String -Pattern @(
  'WEDGED'
  'is not a valid absolute path'
  "Can't access working directory"
  'already in flight'
  'no response for [0-9]+s'
  'exit decision: willRestart=false'
  'restart request IGNORED'
  'Runtime keeps failing'
  're-held for the next idle'
  'code=1[^0-9]'
  'on a down runtime'
  'Runtime restart failed'
  'dropping [0-9]+ queued'
  'session/resume failed'
  'escalating to force kill'
  'provider throttle'
  'usage limit'
  'RATE_LIMITED'
  'scheduling restart #[2-9]'
  'restarts=[1-9]/5'
  'heartbeat failed'
  'HTTP 50[0-9]'
)
```

**Mac/Linux:**
```bash
tail -f -n 0 dev.log | grep -E --line-buffered \
 "WEDGED|is not a valid absolute path|Can't access working directory|already in flight|no response for [0-9]+s|exit decision: willRestart=false|restart request IGNORED|Runtime keeps failing|re-held for the next idle|code=1[^0-9]|on a down runtime|Runtime restart failed|dropping [0-9]+ queued|session/resume failed|escalating to force kill|provider throttle|usage limit|RATE_LIMITED|scheduling restart #[2-9]|restarts=[1-9]/5|heartbeat failed|HTTP 50[0-9]"
```

### What each signature means

| pattern | meaning |
|---|---|
| `WEDGED` | runtime down, work owed, nothing scheduled to bring it back. Always real. |
| `is not a valid absolute path` | a shared `project.repo_path` belongs to the other rig — agents about to die |
| `no response for Ns` | idle watchdog fired. Pre-`ed538f8` this fired on healthy long turns. |
| `exit decision: willRestart=false` | a process died and nothing will restart it |
| `scheduling restart #[2-9]`, `restarts=[1-9]/5` | **escalation** — the ladder is climbing |
| `dropping N queued` | queued human prompts being discarded |
| `re-held for the next idle` | mail offer failed to dispatch and was re-held |
| `already in flight` | a prompt hit a live turn — the claude single-flight rejection |

### Three traps that cost real time

1. **`code=1` matches `code=143` unless you anchor it.** 143 is SIGTERM — the normal healthy
   exit of a cancel. Always `code=1[^0-9]`.
2. **Alert on escalation, not the first restart.** `scheduling restart #1` after a cancel is
   correct. Wire the alarm to `#2`+ or a non-zero restart count, or healthy recoveries bury you
   and you stop reading.
3. **Every pipe stage must flush per line.** `grep --line-buffered`, `awk` needs `fflush()`,
   `head` can't flush at all. A silent watcher looks identical to a quiet system.

### Coverage — silence is not success

Before arming, ask: *if the thing I care about crashed right now, would my filter emit anything?*
If not, widen it. A filter that greps only the success marker stays silent through a crashloop,
and silence reads as "still running." Prefer noise over a blind spot.

---

## 3. Read the window, never the line  ← the part that matters

A matched line tells you something happened. It does **not** tell you what. When one fires:

1. **Pull ~40 lines either side.** The cause is almost never on the matched line.
2. **Reconstruct the sequence with timestamps.** "Prompt → turn started → cancel" looks
   instantaneous in an unstamped log; with stamps it was 2m41s of productive work interrupted at
   the end. Opposite conclusions, same three lines.
3. **Cross-check against a second witness before reporting:**
   - `~/.claude/projects/<dir>/<session-id>.jsonl` — the agent's actual transcript (did it
     receive it / act on it / get cut off).
   - the API, directly with curl (is the state what the log implies).
   - the source (is this the intended behaviour).

**The rule: an error message is evidence about one code path, not a fact about the system.**

Real misreads, all caught by step 3:
- A generic `FORBIDDEN` string read as a capability verdict — it had fired on a valid `SELECT`,
  which was the tell. Cost: a migration plan built for the wrong tool.
- A message called "dropped" from two adjacent lines — the transcript showed 2m41s of work and a
  real finding.
- `MEMBER_AUTH_REQUIRED` taken as proof a token worked — that check runs *before* auth; the token
  was four days dead.

---

## 4. What "success" looks like

After a bounce, a healthy rig reads zero on every fault class (`WEDGED`, `is not a valid absolute
path`, `no response for`, `code=1[^0-9]`, `already in flight`, `RATE_LIMITED` → 0), and **one
benign five-line shape per user cancel**:

```
human cancel — queueing a report-and-stop turn so the interrupted work is not lost
exit decision: willRestart=true (intentional=false healthy=true cancelled=true ...)
scheduling restart #1 in 1000ms
resumed session <id>
session resumed; draining N queued prompt(s)
```

That shape is correct and needs no action. Learn it, or you'll chase it.

---

## 5. The one thing to internalise (and Phase 1's limit)

**A 200 is not evidence.** Monitoring cannot catch a fake-green — a surface that accepts input,
returns `{"success":true}`, persists nothing, and reports success (kanban archive,
`addParticipant`, chat `sendMessage`). None log anything wrong. They're caught by a *different*
discipline: after any write that matters, **re-read the state and compare to what you asked for**
— not "did the call return," *did the value take.*

Spotting catches **stoppage and crashes**; re-read-after-write catches **fake-greens**. Phase 1
covers the first class only — the second is out of a log-watcher's reach by construction.
