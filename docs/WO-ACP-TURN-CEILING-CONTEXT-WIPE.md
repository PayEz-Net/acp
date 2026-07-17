# WO: Stop Turn Ceiling From Wiping Agent Context

**Status:** Implemented 2026-07-17 (off-ACP agent — ACP runtime was down; executed in NextPert's stead) — QA PASS (QAPert, 2026-07-17, mail 11375) — awaiting commit decision (Jon)
**Owner:** NextPert
**Reviewer:** QAPert
**Date:** 2026-07-17
**Requested by:** Jon (via BAPert)

---

## Problem

Agents lose their entire conversation context mid-task whenever a single turn runs long. User-facing symptom: `[Send failed] session/prompt exceeded maximum time of 600000ms`, after which the agent comes back with a wiped session and no memory of the work in flight. Long, healthy turns (multi-step research, builds, large refactors) legitimately exceed 10 minutes, so this fires during normal productive work — and any prompts queued behind the turn (including mail injections) are dropped at the same time.

## Root cause

File: `acp-desktop/src/main/acp/AcpRuntimeManager.ts`

1. `executePrompt` races `session/prompt` against a hard wall-clock ceiling `PROMPT_MAX_MS = 600_000` (line ~476). The ceiling rejects the prompt promise after 10 minutes **regardless of turn health** — it cannot distinguish a hung runtime from a busy one.
2. The failure path (`.catch`, lines ~511-527) treats every prompt failure identically: it drops all queued prompts (`dropQueuedPrompts`) and calls `scheduleRestart` → `restart()` → `kill()` (SIGTERM, `sessionId = null`) → `start()` → `session/new` (line ~307). A brand-new process with a brand-new session means total context loss — even when the old process was perfectly healthy. The code never attempts `session/cancel` to abort just the turn, and never uses `session/load` even though the runtime advertises `loadSession: true` capability.
3. The ceiling only exists because the inactivity watchdog is too permissive: `handleNotification` calls `markPromptActivity()` on **any** notification (line ~667), so a hung-but-chatty runtime (meaningless keepalives) never trips the 5-minute idle watchdog (`PROMPT_IDLE_MS = 300_000`, line ~133). The 10-minute ceiling is the backstop for that gap — and it false-positives on healthy long turns.

## Required change

File: `acp-desktop/src/main/acp/AcpRuntimeManager.ts` (plus `AcpRuntimeManager.test.ts`)

1. **Remove the `PROMPT_MAX_MS` hard ceiling** from `executePrompt` (the `timeoutPromise` and its `Promise.race`). Wall-clock duration must never, by itself, kill a turn.
2. **Make the watchdog count only meaningful activity.** In `handleNotification`, reset idle ticks only for content-bearing `session/update` notifications (e.g. `agent_message_chunk`, `tool_call`, `tool_call_update`, `plan`) — not for keepalive/no-op traffic. A runtime that streams noise while producing nothing must still trip the idle watchdog and be restarted. The `PROMPT_IDLE_MS = 300_000` budget stays as the sole hang detector.
3. **Cancel the turn, keep the session, on non-fatal prompt failure.** When `session/prompt` rejects (or the watchdog trips) while the runtime process is still alive: send `session/cancel` for the in-flight turn, emit the error event plus a `turn_complete` (so the renderer clears its spinner), keep `sessionId`, and drain the prompt queue normally instead of dropping it. Only `scheduleRestart` when the process has actually exited/died or fails to respond.
4. Update `AcpRuntimeManager.test.ts`:
   - Remove or replace tests asserting the 600s ceiling kills a turn.
   - Add coverage: a turn that stays active (content-bearing notifications) past 10 minutes completes normally with the same `sessionId`.
   - Add coverage: a prompt rejection with a live process triggers `session/cancel`, preserves `sessionId`, and drains the queue.
   - Keep coverage that a silent hung runtime (no meaningful notifications for `PROMPT_IDLE_MS`) is restarted.

## Acceptance criteria

- A healthy turn is never aborted by wall-clock duration; turns longer than 10 minutes complete with context intact.
- A failed or hung turn does not wipe conversation context when the runtime process is alive — the session survives, the turn is cancelled, and queued prompts drain.
- A genuinely hung runtime (no meaningful activity for 5 minutes) is still detected and restarted.
- No queued prompt is silently dropped while the session is alive.
- Existing prompt serialization (single in-flight, queue drain) and permission flows remain intact.

## Scope

`acp-desktop` only — `AcpRuntimeManager.ts` and its test file. Do not modify the ACP adapter, kimi runtime, or acp-api unless a blocker is discovered (report back to BAPert if so).

## Follow-up (not in this WO)

The runtime advertises `loadSession: true`. A future WO can use `session/load` to resume the prior session after a genuine process crash, closing the last context-loss gap.
