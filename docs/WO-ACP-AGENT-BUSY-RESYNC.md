# WO: Handle turn.agent_busy — Re-sync Instead of Failing the Prompt

**Status:** Implemented 2026-07-17 (NextPert — 3 new tests, 40/40 manager tests) — pending QAPert review — patch applies AFTER the wait-state Phase B patch
**Owner:** NextPert (queue behind WO-RUNTIME-WAIT-STATE-VISIBILITY + WO-PAYEZ-PROMO-FRONTEND)
**Reviewer:** QAPert
**Date:** 2026-07-17
**Requested by:** BAPert (evidence from live console, Jon-confirmed)

---

## Problem

When `session/prompt` rejects with `turn.agent_busy` (JSON-RPC -32600, `data.code: 'turn.agent_busy'`), the runtime is telling us: **a turn the manager believes is over is still running.** The current `.catch` live-process branch (`AcpRuntimeManager.ts:570-584`) treats this like any other rejection:

1. sends `session/cancel` — which targets the **still-running** turn (possibly a healthy one),
2. `failPendingTurn` — emits error + `turn_complete`, so the renderer clears the spinner and shows an error for a prompt **whose content never executed**,
3. `drainPromptQueue` — dispatches the next queued prompt, which will *also* be rejected `agent_busy` (the runtime is still busy) → **cascade of failed prompts** until the zombie turn actually ends.

## Evidence (live console, 2026-07-17 ~09:27 — `acp-desktop/docs/acp-console-excerpt-20260717.md`)

BAPert prompt id=23 (a mail injection) rejected: `Cannot launch a new turn while another turn (ID 20) is active`. The manager believed it was idle (promptInFlight=false) while the runtime still ran turn 20. Desync origin: the manager-side cancel path (`failPendingTurn` / watchdog `:172-181`) marks the turn settled locally, but `session/cancel` is **best-effort** — a runtime that ignores it keeps the turn alive. Next prompt → `agent_busy`. In this instance the queue happened to be empty; with queued prompts it would have cascaded.

## Required change (`acp-desktop/src/main/acp/AcpRuntimeManager.ts` + test file only)

In the `executePrompt` `.catch` live-process branch, special-case `turn.agent_busy`. **Detection is message-match** (NextPert 11406): AcpProcess flattens JSON-RPC errors to `message (code N)` and `data.code` does not survive — match the `turn.agent_busy` literal or the adapter's `Cannot launch a new turn while another turn` phrasing; fall back to `data.code === 'turn.agent_busy'` if a future AcpProcess enrichment preserves `data` (enrichment noted as follow-up, out of scope):

1. **Do NOT send `session/cancel`** — the busy turn may be legitimate work; we have no handle proving it is the zombie we wanted dead.
2. **Do NOT fail the prompt** — re-queue it at the FRONT of the prompt queue with its resolve intact.
3. **Re-sync:** treat the runtime as turn-in-flight (restore `promptInFlight = true`). **Watchdog runs ONE continuous budget across the whole agent-busy episode** (NextPert refinement 11406, endorsed): no idle-tick resets on `agent_busy` rejections or retry dispatches — re-arming per retry would reset the idle clock every 5s and a wedged busy-turn would NEVER trip the 300s watchdog (would violate AC #4). The runtime may still stream the active turn's notifications — those still reset via `handleNotification` as today; a wedged busy-turn trips ~300s from the original dispatch.
4. **Bounded retry dispatch:** since the adapter emits no `turn_complete` notification for the zombie turn (its original promise is already settled manager-side), the manager learns the runtime is free only by retrying: re-attempt dispatch of the re-queued prompt on a short backoff (suggest 5s, capped attempts or bounded by the watchdog). If the runtime is truly wedged, the existing 300s idle watchdog remains the backstop and restarts as today.
5. Generic rejections (auth errors, SDK failures) keep the current cancel-keep-session behavior — only `agent_busy` changes.

## Acceptance criteria

1. A `turn.agent_busy` rejection never fails the user/mail prompt: it dispatches successfully once the active turn ends; no error/`turn_complete` is emitted for it in the interim.
2. No `session/cancel` is sent in response to `agent_busy`.
3. Two+ prompts queued behind an `agent_busy` rejection all dispatch in order after the active turn ends (no cascade).
4. A genuinely wedged busy-turn still trips the 300s idle watchdog and restarts (existing behavior preserved).
5. Non-`agent_busy` rejections keep the current cancel/keep-session/drain behavior (regression coverage stays green).
6. New tests cover 1–4; full suite + both tsc configs pass.

## Scope

`AcpRuntimeManager.ts` + `AcpRuntimeManager.test.ts` only. No adapter/runtime changes (the wait-state WO separately makes zombie turns *visible*; this WO makes the manager survive them).

## Estimate

~0.5d incl. tests.

---

## Update 2026-07-27 — hardening implemented: probe-now, capped escalation, skip-resume-once

Follow-up after a live incident (a cron-launched turn right after `session/resume` spun the boot prompt through 16+ retries; `markHealthy()` reset `restartCount` after each resume, so `MAX_RESTARTS` never bounded the loop):

1. **Probe-now on turn_complete** (`probeAgentBusyRetryNow`): an inbound `turn_complete` while a busy retry is armed cancels the pending 5s timer and re-dispatches immediately. Guarded by the armed timer, so ordinary turn completions never cause extra dispatches.
2. **Capped escalation** (`MAX_AGENT_BUSY_REJECTIONS = 12` ≈ 60s of probing — the "capped attempts" option in item 4 above): on the 12th consecutive `turn.agent_busy` rejection the manager stops probing and takes the watchdog path (best-effort `session/cancel` + `failPendingTurn` + `restart`), with one difference: the restart **skips resume once** and falls back to `session/new` — a busy condition that survives a capped episode is a property of the resumed session, and re-resuming it just re-enters the loop. The re-queued prompt settles via the existing fresh-session queue drop. The skip is a one-shot `skipResumeOnce` flag consumed in `startOnce()`, so subsequent restarts resume normally again.
3. **Watchdog trip mid-episode also skips resume once** — same reasoning when a busy episode consumed the whole 300s idle budget without the runtime freeing up.

Unchanged: retries never re-arm the idle watchdog, the busy catch never resets idle ticks, and there is no mid-episode `session/cancel` escalation beyond the capped/watchdog paths above.
