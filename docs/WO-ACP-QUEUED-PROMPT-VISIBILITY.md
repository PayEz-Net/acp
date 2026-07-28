# WO: Queued-Prompt Visibility — Show "Queued Behind Current Turn"

**Status:** Ready for implementation
**Owner:** NextPert
**Reviewer:** QAPert
**Date:** 2026-07-17
**Requested by:** Jon

---

## Problem

Prompts are serialized per agent: one in flight, the rest queue (`AcpRuntimeManager.ts:501-506`). The queue drains promptly on turn completion — this works. But the renderer shows **nothing** while a prompt sits queued: to the user it looks like the message was swallowed until the (possibly multi-minute) turn finishes. This was the lived experience behind the 2026-07-17 "everything waits for the timer" report (evidence: `docs/acp-console-excerpt-20260717.md` — user prompts at queueDepth 1–3 draining on turn completion).

## Required change (small: main + renderer)

1. **Main (`AcpRuntimeManager.ts`):** emit queue-state ACP events alongside the existing console logs — on enqueue (`prompt_queued` with `queueDepth`) and on dequeue/dispatch (`prompt_dequeued` with `queueDepth`), plus on `dropQueuedPrompts` (`queue_cleared`). Reuse the existing `emitAcpEvent` channel; no protocol changes (renderer-only events).
2. **Renderer (`acpSessionStore`):** track `queuedCount` per agent from those events; clear on `queue_cleared`, session loss, and restart.
3. **UI:** when `queuedCount > 0`, show a quiet indicator at the active terminal/transcript — "Queued behind current turn (N)" — near the composer or in the turn-status area (match `ActivityIndicator` styling; NextPert's call on exact placement). No buttons, no preempt — information only (preemption is a separate product decision, out of scope).

## Acceptance criteria

1. Typing + sending during an in-flight turn immediately shows the queued indicator with correct depth.
2. Indicator counts down as the queue drains and disappears at 0.
3. Watchdog restart / queue drop clears the indicator (no stale "queued" ghosts).
4. No change to dispatch semantics — serialization order and timing untouched.
5. Tests: store transitions + a component render test; full suite + both tsc configs green.

## Estimate

~0.5d. Queue behind current work (promo-frontend review follow-ups, model-override layers).
