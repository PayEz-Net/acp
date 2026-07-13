# WO: Fix spinner / "task done" reporting gaps

> **From:** BAPert  
> **To:** NextPert  
> **CC:** QAPert, DotNetPert  
> **Status:** Ready for implementation  
> **Source:** [`docs/SPINNER_TASK_DONE_AUDIT.md`](./SPINNER_TASK_DONE_AUDIT.md)

---

## 1. Background

`Nextpert-Scout` audited all spinner / loading-state code paths in `acp-desktop` and identified where a "task done" signal can be lost. The ACP/Kimi path is mostly fixed by uncommitted changes, but still has gaps. The PTY / Claude-Codex path is the highest remaining risk because it has no explicit done message and no timeout.

## 2. Goal

Eliminate stuck-spinners for the next release by landing the existing ACP fixes, adding timeouts, and surfacing terminal errors. Defer lower-risk UI polish to a follow-up slice.

## 3. Scope split

### 3.1 Must fix before next release

| # | Issue | Files | Fix |
|---|---|---|---|
| 1 | **Land existing uncommitted ACP fixes** | `AcpRuntimeManager.ts`, `acpSessionStore.ts` | Commit the working-tree changes already in place (default `stopReason`, `cancel()` turn_complete, `ensureAssistantTurn` guard, tool-call completion, `failActiveTurn`). |
| 2 | **Add `session/prompt` timeout** ✅ | `AcpRuntimeManager.ts` | If `session/prompt` does not resolve/reject within 120 s, emit `error`/`turn_complete` so the spinner clears. Implemented by QAPert 2026-07-13. |
| 3 | **Surface runtime `stderr` as an error event** | `acpSessionStore.ts`, `AcpRuntimeManager.ts` | When fatal stderr is emitted, fail the active turn so the spinner clears. |
| 4 | **Add PTY heartbeat / timeout** | `terminalStream.ts`, `useAgentStatusStore` | If no recognized completion footer is seen within ~120 s of the last output chunk, clear `thinkingLive`. |
| 5 | **Reset `composing` footer state** | `terminalStream.ts` | Clear `composing` when the provider stops printing composing footers. |

### 3.2 Follow-up (post-release)

| # | Issue | Files |
|---|---|---|
| 6 | Unify header/footer spinner state | `UnifiedTerminal.tsx`, `TerminalPane.tsx` |
| 7 | Permission request stall | `acpSessionStore.ts` |
| 8 | Process exit double event | `AcpProcess.ts`, `AcpRuntimeManager.ts` |
| 9 | Global `onAcpEvent` subscriber fragility | `App.tsx` |

## 4. Required changes

### 4.1 ACP timeout

Implemented by QAPert 2026-07-13. `AcpRuntimeManager.sendPrompt` now races `this.process.request('session/prompt', ...)` against a 120 s timeout. If the timeout wins, it emits an `error` event so `acpSessionStore` fails the active turn and clears the spinner. The late-settled request is ignored via a `settled` guard.

Original requirement: wrap the request with a timeout and emit `error`/`turn_complete` on expiry.

### 4.2 PTY timeout

In `terminalStream.ts`, track the timestamp of the last chunk that moved `thinkingLive` to `true`. If no new chunk arrives within `PTY_THINK_TIMEOUT_MS` (120 s) and no recognized done footer was seen, force `thinkingLive = false`.

### 4.3 `stderr` handling

Pipe ACP runtime `stderr` into the same event stream as `error` events, or call `failActiveTurn()` when stderr contains a fatal marker.

### 4.4 `composing` reset

Set `composing = null` when a chunk arrives that is not a composing footer and no other composing indicator is present.

## 5. Acceptance criteria

- [x] Stuck "Answering…" spinner from image-paste remains fixed.
- [x] A Kimi prompt that hangs at the transport layer clears the spinner within 120 s.
- [ ] A Claude/Codex PTY that stops printing without a recognized footer clears the spinner within 120 s.
- [ ] `stderr` output that indicates a runtime error clears the spinner and shows an error state.
- [x] Existing `npm test -- src/main/acp/AcpRuntimeManager.test.ts src/renderer/stores/acpSessionStore.test.ts` continues to pass; new regression tests added for timeout and stderr cases.

## 6. Test plan

1. Run unit tests: `npm test -- src/main/acp/AcpRuntimeManager.test.ts src/renderer/stores/acpSessionStore.test.ts`.
2. Add test: simulate `session/prompt` never resolving and assert `turn_complete` is emitted.
3. Add test: simulate `{}` response from `session/prompt` and assert spinner clears.
4. Manual: start a Claude Code PTY, disconnect the network mid-think, verify spinner clears after timeout.
5. Manual: paste an image into an ACP terminal and verify spinner does not stick.

## 7. References

- `acp-desktop/docs/SPINNER_TASK_DONE_AUDIT.md`
- `acp-desktop/src/main/acp/AcpRuntimeManager.ts`
- `acp-desktop/src/renderer/stores/acpSessionStore.ts`
- `acp-desktop/src/renderer/lib/terminalStream.ts`
