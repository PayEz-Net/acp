# ACP — TODO

Working list for "Finish The ACP" (project 12). Kept here rather than on the kanban
because two of the items below are *about* the kanban, and it currently files cards to
the wrong project and serves cached list rows — tracking its own defects on itself is
circular. Move these to cards once #2 and #3 are fixed.

Each item states the symptom, the evidence, and the fix. Anything without evidence is
a guess and belongs at the bottom.

---

## 1. Pastes over 16 KB are silently truncated before the agent sees them

**Symptom.** Paste a large block into an agent's message box. The chat UI shows all of
it. The agent receives only the first ~16 KB. No error, no warning, no log line.
Found by Jon, 2026-08-08.

**Cause.** `src/main/pty.ts` → `drainPtyWrite()` (~line 438).

```
const PTY_WRITE_CHUNK   = 16384;   // bytes per write
const PTY_WRITE_PACE_MS = 4;       // gap between chunks
```

≤ 16,384 chars goes out as one `pty.write()` and arrives intact. Over that, it is split
into chunks with a 4 ms `setTimeout` between them — fragmenting the bracketed-paste
envelope (`ESC[200~ … ESC[201~`). The child TUI's paste parser finalizes on the first
fragment and discards the rest.

This is the same defect an earlier fix closed, left open above 16 KB. The comment block
above those constants documents the 2026-06-17 measurement and states the mechanism
exactly; that fix raised the single-write threshold so ordinary pastes stop being split,
but kept the split for larger ones. Its defence — *"at 16 KB they fragment 16× less than
the old 1 KB"* — treats this as proportional. It isn't: **one boundary is enough.**

**Fix.** Never split inside a bracketed paste — one `pty.write()` regardless of size.
The same comment already records that ConPTY delivers a single write of up to ~24 KB
losslessly even to a deliberately slow-draining child, so 16 KB is already conservative.
Above ~24 KB is unmeasured; measure it rather than assume. If a split is genuinely
required for very large pastes, drop the pacing gap and write chunks back-to-back so no
read boundary opens mid-paste.

**Also required (see #7).** There is no logging of PTY writes at all, so this was
invisible. Fixing the split without adding the log leaves the next regression just as
undetectable.

**Test.** Write a >16 KB bracketed paste into a byte-counting child; assert received ==
sent. The 2026-06-17 investigation already built that harness.

**Workaround.** Paste in halves, or write to a file and give the agent the path.

**Scheduling.** Needs an app restart. Card `186545` already schedules exactly one cold
boot — this belongs in that list, not its own restart.

---

## 2. Kanban ignores `project_id` on create AND list  (card 117431)

**Reproduced 2026-08-08**, using the card for item #1 as the test case:

- Created with `project_id=12` → landed on project **31** (the active project).
- Listed with `?project_id=12` → returned **359 cards**, including the one on project 31.

**And it cannot be corrected after the fact.** `PATCH` permits `title, description,
priority, milestone, blockers, specPath, filesChanged`. `projectId` is not editable. The
only way to file on a non-active project is to switch the active project, which disturbs
mail routing (`139077`). Card `187311` is misfiled on 31 and stuck there.

**Fix.** Honour `project_id` on both create and list — or reject the parameter outright.
An API that accepts a parameter and silently ignores it is worse than one that refuses
it. Add `projectId` to the PATCH allow-list, or provide a move endpoint, so misfiled
cards are recoverable.

**Verification step.** Move card `187311` to project 12.

---

## 3. Kanban list serves a cached response with a bad key  (card 121194)

Params are ignored and `offset=39` returns the same rows. Combined with #2, **every
measurement taken off that board is suspect** — including the "128 unassigned cards"
count that drove the 2026-08-08 grouping exercise. Fix this before trusting any further
board analytics.

---

## 4. `archived` is under-reported by the list projection

The kanban **list** reports `archived=false` for cards whose **detail** reports
`archived=true`. Confirmed on cards `172176` and `113049` (2026-08-08). Effect: archived
cards read as live backlog and inflate every triage count.

The cloud half of the fix already exists — `d968b8bee`, *"172128: expose `archived` on
the kanban list-row projection"* — committed on PayEz-Core master and **not deployed**.
Related card: `172128` (no archived list/view).

---

## 5. Status-change notifications fail on every card move

```
[kanban] status-change notification FAILED for task NNNNN -> review
(transition still applied): mail API 401:
{"message":"Agent 'system' is not registered"}
```

The transition applies; the notification 401s because the notifier identifies as agent
`system`, which is not in the roster. **Move a card and the assignee is never told.**
Fires on every single move — observed dozens of times in one session.

**Fix.** Register `system` as a real roster identity, or have the notifier use an
existing registered identity. Same class as card `118078` (register `acp-spotter` as a
real team member).

---

## 6. Agent status was reset to `offline` on every team-sync poll  — FIXED 2026-08-08

`setAgents` in `src/renderer/stores/appStore.ts` hardcoded `status: 'offline'` while
preserving `terminalId` and `runtimeProvider` beside it. `ready` is written once at
spawn, so the first poll after startup flipped the whole roster to `offline` and nothing
wrote it back — the roster read "offline" for agents that were mid-task.

Fixed: status is preserved when a live `terminalId` exists, which is the same evidence
the two adjacent fields already trust. Six regression tests added; four of them fail
against the previous line. Left here as the record of why those tests exist.

---

## 7. Nothing logs PTY writes

No paste length, no chunk count, no truncation notice. Verified against a live 224 KB
session log: zero `[PTY] write` / `[PTY] paste` lines. The only size warning in `pty.ts`
fires for **boot prompts** (`"chunked paste may not land cleanly"`) — i.e. only for the
case the code generates itself, never for the case a human triggers.

**A truncated paste and a short paste are indistinguishable from every log we keep.**
That is why #1 survived a previous round of fixing, and it is arguably the more
important half of that bug.

---

## 8. Terminal history ingestion collapses  (card 117107, critical)

*"28 lines in 5 hours of peak sprint."* Reproduced 2026-08-08: all six agents reported
`OUTPUT STALLED — zero rows reported to the cloud record in 5m` simultaneously. Six at
once is systemic, not six coincidences.

Note for whoever picks this up: a dead reporting pipeline and a genuinely idle agent are
indistinguishable from the log. **CPU delta is the discriminator**, not transcript
growth.

---

## Smaller, still real

- **Chat is fake-green** (`175244`) — `POST /chat/conversations/:id/messages` returns
  success plus an id, and nothing persists; `GET messages` comes back empty.
- **App name is a compile-time constant** (`121360`) — `'Acme'` in three sites with no
  config path, so the admin console cannot rename the product.
- **UI lockup from catastrophic regex backtracking** in `terminalStream.ts` (`114877`,
  root cause of `114859`) — both closed 2026-08-08, listed here so the pattern is
  remembered: one renderer pegged a full core while the main process sat idle.

---

## Suggested order

**#2 and #3 first**, quietly and together. They are the measuring instrument — while the
board ignores parameters and serves cached rows, every count and every grouping taken
from it is unverified, including the ones currently driving work assignment.

**Then #1 + #7 together.** The fix and the instrumentation belong in one change; shipping
the fix alone recreates the conditions that hid it.

**Then #5**, which is cheap and restores the feedback loop between moving a card and the
assignee learning about it.

#8 is the largest and the least understood — it deserves its own investigation rather
than a slot in a sweep.
