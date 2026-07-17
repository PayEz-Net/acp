# WO: Runtime Wait-State Visibility — Replace Timer-Guessing With Real Signals

**Status:** Implemented 2026-07-17 (NextPert — both phases, all suites green) — pending QAPert review (mail 11393) — patched binary installing via rename-swap, no live-runtime kills
**Owner:** NextPert
**Reviewer:** QAPert
**Date:** 2026-07-17
**Requested by:** Jon (via BAPert)

---

## Problem

Hang detection between acp-desktop and the Kimi runtime is timer-guessing. The 300s idle watchdog (`PROMPT_IDLE_MS`, `acp-desktop/src/main/acp/AcpRuntimeManager.ts:143`) cannot distinguish "working silently" from "wedged" — and silence is frequently legitimate:

1. **Pre-first-token window:** provider latency plus `chatWithRetry` backoff (10 attempts, ≤32s delays — `kimi-code/packages/agent-core/src/loop/retry.ts:16-25`) means 2–3 minutes of *deliberate* silent waiting is normal.
2. **Hung HTTP attempt:** kosong providers pass **no `timeout` and no `maxRetries`** to the OpenAI/Anthropic SDKs (`packages/kosong/src/providers/kimi.ts:428-432`, `openai-legacy.ts:679-691`, `openai-responses.ts:1197`, `anthropic.ts:1176-1183`), so one hung request can sit up to the SDK's ~10-min socket default before retry logic even engages — long enough to false-trip the watchdog and kill a healthy turn.
3. **Long tool executions** whose tools never emit `tool.progress`; pre-turn compaction (`acp-adapter/src/session.ts:731-757`).

The waiting-state data **already exists** inside the runtime but is dropped at the boundary: agent-core dispatches `step.retrying` events with `failedAttempt/nextAttempt/maxAttempts/delayMs` (`packages/agent-core/src/loop/retry.ts:75-85`) and the ACP adapter has no mapping for them. Jon's requirement: *get a report back from whatever the runtime is waiting on — no tweaked timers.*

Verified recon (2026-07-17) also corrects two assumptions: **no keepalive frames exist** — all adapter notifications are event-driven (`AcpRuntimeManager.ts:894-897` already documents this) — and the live runtime is the installed `~/.kimi-code/bin/kimi` **v0.24.2** while the repo is at **0.27.0** (see Deployment caveat).

## Required change — two repos, two phases

### Phase A — `E:/repos/kimi-code` (upstream; ships via publish)

**A1. Surface wait-state over ACP.** Map agent-core's `step.retrying` events into ACP session traffic in `packages/acp-adapter/src/session.ts` + `src/events-map.ts`, so the client sees "waiting on provider — attempt 3/10, next retry in 12s" as it happens. Cover the other two legitimate-silence sources as well: emit turn-phase/wait-state at pre-first-token (before first `assistant.delta`) and note that tool waits are already visible when tools emit progress — tools that don't are a separate tooling fix, out of scope. Use the existing notification machinery (`conn.sessionUpdate`); do not invent a side channel.

**A2. Per-request timeouts at the layer that knows.** Add explicit `timeout` + `maxRetries` to the SDK clients in the four kosong providers (refs above). A hung HTTP attempt must fail fast and enter the existing, now-observable `chatWithRetry` loop — converting most "hangs" into *reported, retried events* instead of silence. Values: propose and justify in review; the constraint is that a single wedged attempt must cost far less than `PROMPT_IDLE_MS`.

### Phase B — `E:/repos/acp-desktop` (ships independently)

**B1. Watchdog consumes wait-state.** Treat the new wait-state notifications from A1 as meaningful activity in `MEANINGFUL_SESSION_UPDATES` (`AcpRuntimeManager.ts:898-905`) and the dispatch at `:745-809`. This does **not** reintroduce the chatty-but-dead hole: wait-state frames carry advancing attempt/delay data from a live event loop, a wedged runtime cannot emit them, and the retry loop is bounded (10 attempts) — exhaustion produces an error that settles the prompt. The 300s idle budget stays as the sole *silence* detector.

**B2. stopReason harmonization** (folds in QAPert's WO-ACP-TURN-CEILING observation 4): change the two client-synthesized `'cancel'` literals to the adapter vocabulary `'cancelled'` — `AcpRuntimeManager.ts:199-203` (`failPendingTurn`) and `:645-649` (`cancel()`) — plus test expectations at `AcpRuntimeManager.test.ts:442` and `:601`. Optionally narrow `stopReason` in `src/shared/acpTypes.ts:85`. Verified safe: downstream treats stopReason as an opaque string (`acpSessionStore.ts:361`); nothing branches on `'cancel'`.

**B3. Persist `lastSessionId` across app restarts.** `session/resume` is already called on runtime restart (`AcpRuntimeManager.ts:345-357`) and the adapter implements `session/load`/`session/resume` (`acp-adapter/src/server.ts:363-482`), but the session id lives only in memory (`:58`) — an app crash/restart is still a full context wipe. Persist the id via the app's existing settings/prefs mechanism and resume on launch; fall back to `session/new` on `session.not_found` (adapter returns `invalidParams` — `server.ts:476-482`). Runtime-side history survives under `~/.kimi-code/sessions`; `session/load` (with transcript replay, `session.ts:490+`) remains available if renderer-side transcript recovery is ever wanted — not required here since the renderer holds the transcript.

**B4. Surface wait-state in the UI.** Render the A1 wait-state in the active turn (via `acpSessionStore.ts`) — e.g. "Retrying provider — attempt 3/10". A report that reaches the desktop but isn't displayed is half the value.

## Acceptance criteria

1. During provider retry backoff, acp-desktop receives and displays wait-state with attempt/delay data — no silent 2–3 minute gaps.
2. A hung provider HTTP attempt fails fast via the new per-request timeout and enters the visible retry loop; it can no longer false-trip the 300s watchdog.
3. A genuinely wedged runtime (zero notifications) still trips the idle watchdog and restarts — the turn-ceiling WO's hang detection is preserved.
4. `turn_complete` emissions from acp-desktop use only the adapter vocabulary (`end_turn | cancelled | refusal`); tests updated.
5. After an acp-desktop app restart, the prior session is resumed via `session/resume` (context intact); unknown/expired ids fall back cleanly to `session/new`.
6. All existing tests in both repos pass; new behavior covered (adapter event mapping, watchdog meaningful-set, persistence round-trip).

## Delivery path (decided 2026-07-17, Jon)

acp-desktop spawns bare `kimi` from PATH (`providerConfigs.ts:51`, `AcpRuntimeManager.ts:263-272`); the installed binary is **v0.24.2**, repo is at **0.27.0**. Phase A ships via **build + install from the local kimi-code repo with the patch** — do NOT wait for an upstream publish. NextPert: install the patched build as part of delivery, keep the diff clean and re-appliable (the local tree gets hard-reset to origin/main), and stage it as a PR-ready branch; the upstream PR submission itself is coordinated with Jon (outward-facing). Phase B ships independently; B1 degrades gracefully on older runtimes (no wait-state frames → current behavior).

## Out of scope

- Tools that never emit `tool.progress` (per-tool fix, separate WO if wanted).
- Upstream PR submission mechanics (coordinated with Jon, not part of implementation).
- Any .NET/PayEz work.

## Estimate

BA estimate, NextPert to confirm or push back before starting: A1 0.5–1d, A2 0.5d, B1 0.25d, B2 trivial, B3 0.5d, B4 0.5d — **~2.5–3d plus tests**, split naturally into two PRs (one per repo).

## Traceability

- Origin: Jon's directive 2026-07-17 — reports over timers; follow-up flagged in `WO-ACP-TURN-CEILING-CONTEXT-WIPE.md` (§Follow-up) and QAPert review mail 11375 observation 4.
- Technical basis: verified recon of kimi-code 0.27.0 + acp-desktop working tree, 2026-07-17 (all file:line refs above).
