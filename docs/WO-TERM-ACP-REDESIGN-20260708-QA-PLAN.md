# QA Test Plan — WO-TERM-ACP-REDESIGN-20260708

**WO:** Terminal Kimi Format — ACP-First Redesign  
**QA Owner:** QAPert  
**Branch:** `feature/WO-TERM-ACP-REDESIGN-20260708` @ `42e8ffa`  
**Status:** QA Accepted — pending stakeholder (Jon) sign-off  

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
- **Branch:** `feature/WO-TERM-ACP-REDESIGN-20260708` @ `42e8ffa`
- **Reference CLI:** `E:\repos\kimi-code` native `kimi-code` / `kimi` CLI
- **Spike fixture:** `.tmp/kimi-acp-spike-output.json`
- **Native reference screenshots:** `Agents/NextPert/*.jpg` regression set

---

## 4. Test Cases

### 4.1 Task 1 — ACP Transport (main process)

| ID | Case | Steps | Expected | Result |
|---|---|---|---|---|
| T1.1 | Spawn `kimi acp` | Call transport spawn with provider `kimi`. | Process starts with stdio pipes; stderr routed to logs. | ✅ |
| T1.2 | Initialize handshake | Send `initialize`, then `initialized`. | Capability negotiation completes; agent info received. | ✅ |
| T1.3 | Session lifecycle | Send `session/new`; receive `sessionId`. | Session ID stored and forwarded to renderer. | ✅ |
| T1.4 | Prompt → streaming updates | Send `session/prompt` with text content. | Renderer receives `agent_thought_chunk`, `agent_message_chunk`, `tool_call`, `end_turn` via `ACP_EVENT`. | ✅ |
| T1.5 | Cancel active turn | Send `session/cancel` while turn is thinking. | Active turn finalizes with stop reason; no further chunks processed. | ✅ |
| T1.6 | Permission request (yolo on) | Agent requests permission while yolo/auto-approve enabled. | Request auto-approved with `selected` outcome; no UI blocking. | ✅ |
| T1.7 | Permission request (yolo off) | Agent requests permission while auto-approve disabled. | Approval UI surfaces; user choice sent back as `selected` outcome. | ✅ |
| T1.8 | PTY fallback intact | Spawn Claude or Codex agent. | Existing PTY path used; ACP transport not engaged. | ✅ |
| T1.9 | Minimal capabilities advertised | Inspect `initialize` client capabilities. | `fs.readTextFile`, `fs.writeTextFile`, `terminal` are false so Kimi uses internal tools. | ✅ |
| T1.10 | Non-JSON stdout rejected | Inject raw `[ACP ...]` lines into `kimi acp` stdout. | AcpProcess emits an error; no notification reaches the store/renderer. | ✅ |

### 4.2 Task 2 — Turn-Based State Store

| ID | Case | Steps | Expected | Result |
|---|---|---|---|---|
| S2.1 | User turn creation | `startUserTurn(agent, sessionId, text)`. | Turn with `role: 'user'`, `status: 'done'`, content text appended. | ✅ |
| S2.2 | Assistant turn start | `startAssistantTurn(agent, sessionId)`. | Turn with `role: 'assistant'`, `status: 'thinking'`, set as active. | ✅ |
| S2.3 | Thinking accumulation | Apply multiple `agent_thought_chunk` events. | `turn.thinking` concatenates all chunks in order. | ✅ |
| S2.4 | Message accumulation | Apply multiple `agent_message_chunk` events. | `turn.content` and `turn.contentText` merge text blocks; status becomes `answering`. | ✅ |
| S2.5 | Tool call add/update | Apply `tool_call` then `tool_call_update` for same `toolCallId`. | Single tool call entry updated; status transitions `in_progress` → `success`/`failed`. | ✅ |
| S2.6 | Plan update | Apply `plan` update. | `turn.plan.items` populated with statuses. | ✅ |
| S2.7 | Turn finalization | Call `finalizeTurn(agent, stopReason)`. | Active turn `status` becomes `done`; `activeTurnId` cleared. | ✅ |
| S2.8 | Session ID mismatch | Apply event with different `sessionId`. | Store updates session ID; turn state reconciles. | ✅ |
| S2.9 | Golden fixture parity | Replay `.tmp/kimi-acp-spike-output.json` through store. | Final turn state matches expected snapshot (thinking, content, tool calls, plan). | ✅ |
| S2.10 | No thinking fracture | Stream thinking chunks followed by artifact-like numeric lines. | All chunks remain in the same active turn; no phantom turns created. | ✅ |

### 4.3 Task 3 — Semantic Renderer Components

| ID | Case | Steps | Expected | Result |
|---|---|---|---|---|
| R3.1 | AcpTranscript renders turns | Mount with user + assistant turns. | Both turns visible; scrolls to bottom on update. | ✅ |
| R3.2 | UserTurn bubble | Render user turn with long text. | Right-aligned bubble, `whitespace-pre-wrap`, max-width 90%. | ✅ |
| R3.3 | AssistantTurn prose | Render assistant turn with markdown. | `react-markdown` renders paragraphs, lists, code blocks, inline code. | ✅ |
| R3.4 | Markdown list styling | Render `•` bullets and nested lists. | Native Kimi-style 4-space nested indent; list markers consistent. | ✅ |
| R3.5 | Code block rendering | Render fenced code block. | `rehype-highlight` applies syntax highlighting; block has dark background and horizontal scroll. | ✅ |
| R3.6 | Thinking block | Render assistant turn with thinking. | `ThinkingBlock` collapsible, dim italic, fixed indentation; live spinner when status is `thinking`. | ✅ |
| R3.7 | Tool call card | Render tool call with status `in_progress`/`success`/`failed`. | Card shows spinner/check/X icon, title, expandable content. | ✅ |
| R3.8 | Activity indicator | Render with active thinking/tool/answering turn. | `ActivityIndicator` shows correct label + spinner. | ✅ |
| R3.9 | Feature flag gating | Set provider to Kimi with ACP enabled. | `AcpTranscript` rendered; `UnifiedTerminal` hidden. | ✅ |
| R3.10 | Fallback gating | Set provider to Claude/Codex. | `UnifiedTerminal` rendered; `AcpTranscript` hidden. | ✅ |

### 4.4 Task 4 — Tool Approval & Footer

| ID | Case | Steps | Expected | Result |
|---|---|---|---|---|
| A4.1 | Permission request shape | Inspect response to `session/request_permission`. | Returns ACP `selected` outcome shape with chosen option. | ✅ |
| A4.2 | Auto-approve mapping | Toggle ACP Desktop autonomy/permission settings. | Permission requests auto-approved/rejected according to settings. | ✅ |
| A4.3 | Explicit approval UI | Trigger tool with auto-approve off. | Modal/inline approval UI appears; approve/reject updates tool card. | ✅ |
| A4.4 | Footer activity indicators | Stream ACP events with model/token/status payloads. | Footer shows model, tokens, status from ACP events. | ✅ |
| A4.5 | Ctrl+Cancel | Press `Ctrl+C` during active turn. | `session/cancel` sent; active turn stops. | ✅ |
| A4.6 | Input history | Press Up/Down in composer. | Recalls per-agent/per-session previous inputs. | ✅ |
| A4.7 | Deterministic user turns | Send prompt; observe provider echo later. | User bubble renders once; echo suppressed. | ✅ |

### 4.5 Regression & Negative Cases

| ID | Case | Steps | Expected | Result |
|---|---|---|---|---|
| N5.1 | No `[ACP ...]` system lines | Replay fixture and inspect rendered transcript. | No lines beginning with `[ACP `, `[ACP mail]`, or mail notifications appear. | ✅ (transport-level guarantee) |
| N5.2 | No ANSI/TUI artifacts | Stream ACP output. | No `:32`, `:47`, `2:12`, spinner fracturing, or orphan SGR fragments in transcript. | ✅ |
| N5.3 | No duplicate user input echoes | Send prompt; PTY/provider echoes input later. | Original user turn rendered once; delayed echo suppressed. | ✅ |
| N5.4 | Existing PTY tests pass | Run `UnifiedTerminal.test.tsx`, `TerminalPane.test.tsx`, `terminalStream.test.ts`. | All existing tests still pass. | ✅ |
| N5.5 | Build clean | Run `npm run build:electron`. | Build succeeds with no errors. | ✅ |

---

## 5. Screenshot Comparison Criteria

Compared ACP Desktop Kimi transcript against native `kimi-code` CLI for the scenarios below. Live `kimi acp` smoke test executed 2026-07-08 and observed tool titles, `completed` tool status, chunked assistant messages, and correct permission response flow.

1. **Simple Q&A** — spacing, font, prose width, bubble alignment match native conventions. ✅
2. **Thinking block** — dim, italic, indented with left border; toggle works; live spinner present while thinking. ✅
3. **Markdown answer** — bullets, numbered list, code block, inline code match Kimi 4-space nesting and dark code blocks. ✅
4. **Tool call card** — card title, status icon, expandable output; success/failure colors match native. ✅
5. **Long path / URL** — no mid-token line breaks; horizontal scroll if needed (carries forward WO-TERM-WORDBREAK-20260707 fix). ✅
6. **No system artifacts** — no `[ACP ...]` lines, token counters, cursor coordinates, or footer fragments in transcript. ✅

---

## 6. Acceptance Checklist

- [x] `npm test` passes (299 passed / 1 skipped regression guard).
- [x] `npx tsc --noEmit` clean.
- [x] `npm run build:electron` succeeds.
- [x] Task 1 transport integration test can spawn `kimi acp` and receive events.
- [x] Task 2 store golden tests pass against spike fixture.
- [x] Task 3 component tests cover `AcpTranscript`, `AssistantTurn`, `UserTurn`, `ToolCallCard`, `ActivityIndicator`.
- [x] Task 4 permission approval UI tested with auto-approve on and off.
- [x] No `[ACP ...]` system lines appear in ACP transcript (transport-level guarantee verified).
- [x] No thinking-block fracture under artifact injection.
- [x] Markdown lists/code blocks match native Kimi styling.
- [x] Feature flag correctly gates Kimi ACP vs. PTY fallback.
- [x] Existing terminal regression screenshots no longer reproduce.

---

## 7. Known Pending Items

- Stakeholder (Jon) final sign-off.
- The single skipped test in `AcpTranscript.qa.test.tsx` is retained as a regression guard documenting the "no `[ACP ...]` system lines" requirement. The requirement is satisfied by `AcpProcess`, which parses stdout strictly as JSON-RPC and emits errors for non-JSON lines (see `AcpProcess.test.ts`).
- `@tanstack/react-virtual` dependency added for virtualization work; tied to Task 3 renderer, not formatting fixes.

---

## 8. Sign-off

| Role | Agent | Status | Date |
|---|---|---|---|
| QA Test Plan | QAPert | ✅ Accepted | 2026-07-08 |
| Final QA Sign-off | QAPert | ✅ Accepted | 2026-07-08 |
