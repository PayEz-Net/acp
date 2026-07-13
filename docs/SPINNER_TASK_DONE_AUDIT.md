# Spinner / "Task Done" Reporting Audit

**Project:** `acp-desktop`  
**Scope:** All spinner / loading-indicator code paths and how they learn that a task is finished.  
**Author:** Nextpert-Scout  
**Date:** 2026-07-10

## 1. Summary

The app has **two** completion models:

1. **ACP / Kimi path** — structured JSON-RPC with explicit `turn_complete` events. This is the path that recently had the stuck "Answering…" spinner bug.
2. **PTY / Claude-Codex path** — raw terminal bytes; completion is inferred from regex heuristics in `terminalStream.ts`.

The ACP path is now mostly covered after the recent uncommitted fixes, but there are still places where a spinner can stay live or where the "task done" message is lost. The PTY path is the bigger remaining risk because it has no explicit done message and no timeout.

## 2. ACP (Kimi) Path — How the Spinner Learns "Done"

### 2.1 Data flow

| Step | File | What happens |
|------|------|--------------|
| 1 | `src/main/acp/AcpRuntimeManager.ts` | `sendPrompt` calls `AcpProcess.request('session/prompt', …)` |
| 2 | `src/main/acp/AcpRuntimeManager.ts` | While streaming, emits `agent_thought_chunk`, `tool_call`, `agent_message_chunk` |
| 3 | `src/main/acp/AcpRuntimeManager.ts` | When `session/prompt` resolves, emits `turn_complete` (default `stopReason: 'end_turn'`). If it rejects, emits `error`. |
| 4 | `src/main/pty.ts` | Listens for `runtime.on('event')` and forwards `ACP_EVENT` to the renderer via `safeSend('acp:event', …)` |
| 5 | `src/renderer/App.tsx` | Global `onAcpEvent` subscriber routes every event into `useAcpSessionStore.getState().applyEvent(payload)` |
| 6 | `src/renderer/stores/acpSessionStore.ts` | `applyAcpUpdate('turn_complete')` sets `activeTurn.status = 'done'`, `activeTurnId = null`, and completes any in-progress tool calls |
| 7 | `src/renderer/components/AcpTranscript/AcpTranscript.tsx` | Removes `<ActivityIndicator>` when there is no active turn or status is `done`/`error` |

### 2.2 Spinner start points

- `acpSessionStore.createTurn` → status `thinking`
- `agent_thought_chunk` → status `thinking`
- `agent_message_chunk` → status `answering`
- `tool_call` / `tool_call_update` → status `tool`

### 2.3 Spinner stop points

- `turn_complete` event (from `session/prompt` resolution)
- `turn_complete` event (from `session/update` notification)
- `turn_complete` event emitted by `cancel()`
- `error` event (request rejection, process error/exit, start failure)
- `failActiveTurn()` called from UI when the user interrupts or IPC rejects

## 3. Recent Fixes Already in the Working Tree

The following uncommitted changes directly address the stuck spinner:

- `AcpRuntimeManager.sendPrompt` now defaults `stopReason` to `'end_turn'` when `session/prompt` resolves without a string `stopReason`. Previously an empty `{}` result left the spinner in `answering` forever.
- `AcpRuntimeManager.cancel()` defensively emits `turn_complete` even if the runtime never responds.
- `acpSessionStore.ensureAssistantTurn()` no longer resurrects an active assistant turn from stray chunks that arrive **after** a turn already completed (image-paste hang).
- `acpSessionStore` marks in-progress tool calls as completed/failed on `turn_complete` / `error`.
- `failActiveTurn()` gives the UI a way to force-clear a stuck turn.

## 4. Remaining Gaps Where "Task Done" Can Be Lost

### 4.1 ACP-specific gaps

| # | Issue | File(s) | Consequence |
|---|-------|---------|-------------|
| 1 | **No timeout on `session/prompt`** | `AcpRuntimeManager.ts` | If the request never resolves/rejects, the spinner spins forever unless the user cancels. **Fixed by QAPert 2026-07-13:** `sendPrompt` now races the request against a 120 s timeout and emits `error` on expiry. |
| 2 | **Header status pill only knows `thinking`, not `tool`/`answering`** | `UnifiedTerminal.tsx`, `TerminalPane.tsx` | Header shows generic/idle status while footer correctly shows "Tool…"/"Answering…". The same turn looks finished in one place and active in another. |
| 3 | **Inconsistent `stopReason` default** | `AcpRuntimeManager.ts` | `sendPrompt` defaults to `'end_turn'`; `handleNotification` defaults to `'unknown'`. Diagnostics differ depending on which path the runtime used. |
| 4 | **`stderr` events are ignored by the store** | `acpSessionStore.ts` | A fatal runtime error printed only to stderr never clears the spinner unless the runtime explicitly emits `error`. |
| 5 | **Permission request stalls** | `acpSessionStore.ts` | `permission_request` sets `pendingPermission` but does not change turn status. If the user never responds and no `turn_complete` arrives, the spinner stays forever. |
| 6 | **Process exit right after success can emit both `turn_complete` and `error`** | `AcpProcess.ts`, `AcpRuntimeManager.ts` | The spinner stops, but a misleading error banner may appear on a successful turn. |
| 7 | **Single global `onAcpEvent` subscriber** | `App.tsx` | If that subscription is ever unmounted or fails, all ACP completion events are lost app-wide. |

### 4.2 PTY (Claude/Codex) gaps

| # | Issue | File(s) | Consequence |
|---|-------|---------|-------------|
| 8 | **No explicit "task done" message** | `terminalStream.ts` | Completion is guessed from regex heuristics. A silent provider hang leaves `thinkingLive = true` forever. |
| 9 | **No timeout / heartbeat for PTY thinking** | `terminalStream.ts`, `useAgentStatusStore` | If the model stops printing but never prints a recognized footer, the spinner never clears. |
| 10 | **`composing` footer state may never clear** | `terminalStream.ts` | `composing` is set when a regex matches; nothing ever resets it to `null` when the provider stops printing composing footers. |
| 11 | **Mid-think terminal kill drops state silently** | `terminalStream.ts` | If a pane is killed mid-think, downstream overview streams may keep a stale `thinkingLive` line. |

## 5. Recommended Next Steps

1. **Land the existing uncommitted ACP fixes** (they already fix the most common stuck-spinner scenarios).
2. **Add a defensive `session/prompt` timeout** in `AcpRuntimeManager.sendPrompt` (e.g., 60–120 s) that emits `error`/`turn_complete` if the promise never settles.
3. **Unify header/footer spinner state** so the header pill reflects the full ACP turn status (`thinking`/`tool`/`answering`), not just `thinking`.
4. **Surface runtime stderr as an error event** when it looks fatal, or at least fail the active turn so the spinner clears.
5. **Add a PTY heartbeat / timeout** or an explicit "task done" ANSI sentinel so Claude/Codex turns cannot hang silently.
6. **Run the new tests** before landing:
   ```bash
   npm test -- src/main/acp/AcpRuntimeManager.test.ts src/renderer/stores/acpSessionStore.test.ts
   ```
7. **Add an integration test** that simulates Kimi returning `{}` from `session/prompt` and asserts the activity indicator disappears.

## 6. Bottom Line

- **ACP/Kimi:** The explicit `turn_complete` path is solid after the current fixes, but still lacks a timeout and has minor UI inconsistency between header and footer.
- **PTY/Claude-Codex:** This is the highest-risk area. There is no explicit "task done" message; the renderer guesses completion from terminal output, so a silent hang or a provider that changes its TUI format can leave spinners stuck indefinitely.
