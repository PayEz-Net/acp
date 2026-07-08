# QA Test Plan — WO-TERM-ACP-REDESIGN-20260708

**WO:** Terminal Kimi Format — ACP-First Redesign  
**QA Owner:** QAPert  
**Branch:** `feature/WO-TERM-ACP-REDESIGN-20260708`  
**Status:** Conditional acceptance — prep in progress; awaiting Tasks 1–4 completion  

---

## 1. Objective

Verify that the ACP-driven Kimi terminal experience in ACP Desktop matches the native `kimi-code` CLI behavior, renders structured events correctly, and does not introduce regressions in the existing PTY fallback path.

---

## 2. Scope

### In scope
- ACP stdio transport for Kimi (Task 1).
- Turn-based `acpSessionStore` state assembly (Task 2).
- Semantic renderer components in `AcpTranscript/` (Task 3).
- Tool approval handling and footer activity indicators (Task 4).
- Feature-flag gating so only Kimi uses the ACP transcript.
- Build/test hygiene: `npm test`, `npx tsc --noEmit`, `npm run build:electron`.

### Out of scope
- Claude/Codex ACP modes (future WO).
- xterm.js removal (deferred).
- Backend cache/vsql-cache changes unless required by fallback.

---

## 3. Test Environment

- **Repo:** `E:\repos\acp-desktop`
- **Branch:** `feature/WO-TERM-ACP-REDESIGN-20260708`
- **Reference CLI:** `E:\repos\kimi-code` native `kimi-code` / `kimi` CLI
- **Spike fixture:** `.tmp/kimi-acp-spike-output.json`
- **Native reference screenshots:** `Agents/NextPert/*.jpg` regression set

---

## 4. Test Cases

### 4.1 Task 1 — ACP Transport (main process)

| ID | Case | Steps | Expected |
|---|---|---|---|
| T1.1 | Spawn `kimi acp` | Call transport spawn with provider `kimi`. | Process starts with stdio pipes; stderr routed to logs. |
| T1.2 | Initialize handshake | Send `initialize`, then `initialized`. | Capability negotiation completes; agent info received. |
| T1.3 | Session lifecycle | Send `session/new`; receive `sessionId`. | Session ID stored and forwarded to renderer. |
| T1.4 | Prompt → streaming updates | Send `session/prompt` with text content. | Renderer receives `agent_thought_chunk`, `agent_message_chunk`, `tool_call`, `end_turn` via `ACP_EVENT`. |
| T1.5 | Cancel active turn | Send `session/cancel` while turn is thinking. | Active turn finalizes with stop reason; no further chunks processed. |
| T1.6 | Permission request (yolo on) | Agent requests permission while yolo/auto-approve enabled. | Request auto-approved with `selected` outcome; no UI blocking. |
| T1.7 | Permission request (yolo off) | Agent requests permission while auto-approve disabled. | Approval UI surfaces; user choice sent back as `selected` outcome. |
| T1.8 | PTY fallback intact | Spawn Claude or Codex agent. | Existing PTY path used; ACP transport not engaged. |
| T1.9 | Minimal capabilities advertised | Inspect `initialize` client capabilities. | `fs.readTextFile`, `fs.writeTextFile`, `terminal` are false so Kimi uses internal tools. |

### 4.2 Task 2 — Turn-Based State Store

| ID | Case | Steps | Expected |
|---|---|---|---|
| S2.1 | User turn creation | `startUserTurn(agent, sessionId, text)`. | Turn with `role: 'user'`, `status: 'done'`, content text appended. |
| S2.2 | Assistant turn start | `startAssistantTurn(agent, sessionId)`. | Turn with `role: 'assistant'`, `status: 'thinking'`, set as active. |
| S2.3 | Thinking accumulation | Apply multiple `agent_thought_chunk` events. | `turn.thinking` concatenates all chunks in order. |
| S2.4 | Message accumulation | Apply multiple `agent_message_chunk` events. | `turn.content` and `turn.contentText` merge text blocks; status becomes `answering`. |
| S2.5 | Tool call add/update | Apply `tool_call` then `tool_call_update` for same `toolCallId`. | Single tool call entry updated; status transitions `in_progress` → `success`/`failed`. |
| S2.6 | Plan update | Apply `plan` update. | `turn.plan.items` populated with statuses. |
| S2.7 | Turn finalization | Call `finalizeTurn(agent, stopReason)`. | Active turn `status` becomes `done`; `activeTurnId` cleared. |
| S2.8 | Session ID mismatch | Apply event with different `sessionId`. | Store updates session ID; turn state reconciles. |
| S2.9 | Golden fixture parity | Replay `.tmp/kimi-acp-spike-output.json` through store. | Final turn state matches expected snapshot (thinking, content, tool calls, plan). |
| S2.10 | No thinking fracture | Stream thinking chunks followed by artifact-like numeric lines. | All chunks remain in the same active turn; no phantom turns created. |

### 4.3 Task 3 — Semantic Renderer Components

| ID | Case | Steps | Expected |
|---|---|---|---|
| R3.1 | AcpTranscript renders turns | Mount with user + assistant turns. | Both turns visible; scrolls to bottom on update. |
| R3.2 | UserTurn bubble | Render user turn with long text. | Right-aligned bubble, `whitespace-pre-wrap`, max-width 90%. |
| R3.3 | AssistantTurn prose | Render assistant turn with markdown. | `react-markdown` renders paragraphs, lists, code blocks, inline code. |
| R3.4 | Markdown list styling | Render `•` bullets and nested lists. | Native Kimi-style 4-space nested indent; list markers consistent. |
| R3.5 | Code block rendering | Render fenced code block. | `rehype-highlight` applies syntax highlighting; block has dark background and horizontal scroll. |
| R3.6 | Thinking block | Render assistant turn with thinking. | `ThinkingBlock` collapsible, dim italic, fixed indentation; live spinner when status is `thinking`. |
| R3.7 | Tool call card | Render tool call with status `in_progress`/`success`/`failed`. | Card shows spinner/check/X icon, title, expandable content. |
| R3.8 | Activity indicator | Render with active thinking/tool/answering turn. | `ActivityIndicator` shows correct label + spinner. |
| R3.9 | Feature flag gating | Set provider to Kimi with ACP enabled. | `AcpTranscript` rendered; `UnifiedTerminal` hidden. |
| R3.10 | Fallback gating | Set provider to Claude/Codex. | `UnifiedTerminal` rendered; `AcpTranscript` hidden. |

### 4.4 Task 4 — Tool Approval & Footer

| ID | Case | Steps | Expected |
|---|---|---|---|
| A4.1 | Permission request shape | Inspect response to `session/request_permission`. | Returns ACP `selected` outcome shape with chosen option. |
| A4.2 | Auto-approve mapping | Toggle ACP Desktop autonomy/permission settings. | Permission requests auto-approved/rejected according to settings. |
| A4.3 | Explicit approval UI | Trigger tool with auto-approve off. | Modal/inline approval UI appears; approve/reject updates tool card. |
| A4.4 | Footer activity indicators | Stream ACP events with model/token/status payloads. | Footer shows model, tokens, status from ACP events. |
| A4.5 | Ctrl+Cancel | Press `Ctrl+C` during active turn. | `session/cancel` sent; active turn stops. |

### 4.5 Regression & Negative Cases

| ID | Case | Steps | Expected |
|---|---|---|---|
| N5.1 | No `[ACP ...]` system lines | Replay fixture and inspect rendered transcript. | No lines beginning with `[ACP `, `[ACP mail]`, or mail notifications appear. |
| N5.2 | No ANSI/TUI artifacts | Stream ACP output. | No `:32`, `:47`, `2:12`, spinner fracturing, or orphan SGR fragments in transcript. |
| N5.3 | No duplicate user input echoes | Send prompt; PTY/provider echoes input later. | Original user turn rendered once; delayed echo suppressed. |
| N5.4 | Existing PTY tests pass | Run `UnifiedTerminal.test.tsx`, `TerminalPane.test.tsx`, `terminalStream.test.ts`. | All existing tests still pass. |
| N5.5 | Build clean | Run `npm run build:electron`. | Build succeeds with no errors. |

---

## 5. Screenshot Comparison Criteria

Compare ACP Desktop Kimi transcript against native `kimi-code` CLI for these scenarios:

1. **Simple Q&A**
   - User question + assistant answer.
   - Criteria: spacing, font, prose width, bubble alignment match native conventions.

2. **Thinking block**
   - Prompt that triggers visible thinking.
   - Criteria: thinking is dim, italic, indented with left border; toggle works; live spinner present while thinking.

3. **Markdown answer**
   - Prompt that returns bullets, numbered list, code block, inline code.
   - Criteria: list indentation matches Kimi 4-space nesting; code blocks have dark background and horizontal scroll; inline code has subtle background.

4. **Tool call card**
   - Prompt that runs a shell/read/edit tool.
   - Criteria: card title, status icon, expandable output; success/failure colors match native.

5. **Long path / URL**
   - Assistant answer contains long Windows path or URL.
   - Criteria: no mid-token line breaks; horizontal scroll if needed (carries forward WO-TERM-WORDBREAK-20260707 fix).

6. **No system artifacts**
   - Long-running session with status redraws.
   - Criteria: no `[ACP ...]` lines, no token counters, no cursor coordinates, no footer fragments in transcript.

---

## 6. Acceptance Checklist

- [ ] `npm test` passes (current baseline 247+; expect 250+ after transport/approval tests).
- [ ] `npx tsc --noEmit` clean.
- [ ] `npm run build:electron` succeeds.
- [ ] Task 1 transport integration test can spawn `kimi acp` and receive events.
- [ ] Task 2 store golden tests pass against spike fixture.
- [ ] Task 3 component tests cover `AcpTranscript`, `AssistantTurn`, `UserTurn`, `ToolCallCard`, `ActivityIndicator`.
- [ ] Task 4 permission approval UI tested with auto-approve on and off.
- [ ] No `[ACP ...]` system lines appear in ACP transcript.
- [ ] No thinking-block fracture under artifact injection.
- [ ] Markdown lists/code blocks match native Kimi styling.
- [ ] Feature flag correctly gates Kimi ACP vs. PTY fallback.
- [ ] Existing terminal regression screenshots no longer reproduce.

---

## 7. Known Pending Items

- Task 1 transport files (`src/main/acp/AcpProcess.ts`, `AcpRuntimeManager.ts`, `providerConfigs.ts`) not yet in branch.
- Task 4 approval UI and footer activity indicators not yet in branch.
- TypeScript failure: unused `AcpPlan` import in `src/renderer/stores/acpSessionStore.ts`.
- Duplicate ACP payload types in `src/shared/types.ts` to be consolidated.
- `UnifiedTerminal` integration and `AcpTranscript` feature flag wiring pending.

---

## 8. Sign-off

| Role | Agent | Status | Date |
|---|---|---|---|
| QA Test Plan | QAPert | In Progress | 2026-07-08 |
| Final QA Sign-off | QAPert | Blocked pending Tasks 1–4 | — |
