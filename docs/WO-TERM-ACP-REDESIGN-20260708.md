# Work Order: Terminal Kimi Format — ACP-First Redesign

**WO ID:** WO-TERM-ACP-REDESIGN-20260708  
**Status:** Open — awaiting owner acceptance  
**Priority:** High  
**Owner / Lead:** BAPert  
**Implementers:** NextPert (primary), NextPert-Scout (support)  
**QA:** QAPert  
**Stakeholder:** Jon  
**Backend consultant (as needed):** DotNetPert

---

## 1. Objective

Replace the ad-hoc PTY-stream regex normalizer with a structured-event-driven terminal experience for Kimi that matches the native `kimi-code` CLI. Use `kimi acp` (Agent Client Protocol over stdio) as the primary transport and render assistant text, thinking blocks, tool calls, and plans as semantic components.

---

## 2. References

- Approved plan: `docs/TERMINAL_KIMI_FORMAT_PLAN.md`
- Approved plan file: `C:\Users\jon-local\.kimi\plans\wonder-man-phantom-stranger-fire.md`
- Phase 0 spike fixture: `E:\repos\acp-desktop\.tmp\kimi-acp-spike-output.json`
- Previous PRD: `docs/TERMINAL_PROVIDER_UNIFICATION_PRD.md`
- Native reference: `E:\repos\kimi-code`

---

## 3. Scope

### In scope

- Kimi-only ACP runtime and renderer.
- Minimal PTY fallback stub for Claude/Codex.
- Tool approval handling for Kimi ACP sessions.
- Visual polish to match native Kimi conventions.

### Out of scope

- Claude/Codex ACP modes (future WO).
- Removing xterm.js (deferred until all providers are on ACP).
- Backend cache/vsql-cache changes unless explicitly required by fallback.

---

## 4. Task breakdown and owners

### Task 0 — Stabilize working tree
**Owner:** NextPert  
**Acceptance:** Current terminal-formatting changes are committed or stashed; a feature branch exists for this WO.

### Task 1 — ACP transport (main process)
**Owner:** NextPert-Scout  
**Files:**
- `src/main/acp/AcpProcess.ts`
- `src/main/acp/AcpRuntimeManager.ts`
- `src/main/acp/providerConfigs.ts`
- `src/main/pty.ts`
- `src/main/preload.ts`

**Requirements:**
- Spawn `kimi acp` with stdio pipes.
- Send `initialize`, `initialized`, `session/new`, `session/prompt`, `session/cancel`.
- Forward `session/update` notifications to renderer via new `ACP_EVENT` IPC channel.
- Accept `ACP_PROMPT`, `ACP_CANCEL`, `ACP_SET_MODE`, `ACP_KILL` from renderer.
- Handle `session/request_permission` requests by auto-approving under yolo settings or surfacing UI.
- Advertise minimal client capabilities so Kimi uses its own internal tools.
- Keep PTY fallback path intact for non-ACP agents.

**Acceptance:** A standalone integration test can spawn `kimi acp`, send a prompt, and receive `agent_thought_chunk` / `tool_call` / `end_turn` events.

### Task 2 — Turn-based state store
**Owner:** NextPert  
**File:** `src/renderer/stores/acpSessionStore.ts`

**Requirements:**
- Store per-agent session state as a list of turns, not lines.
- Merge streaming `agent_thought_chunk` into the current turn’s thinking.
- Merge streaming `agent_message_chunk` into the current turn’s content.
- Add/update `tool_call` / `tool_call_update` entries.
- Track turn status (`thinking`, `tool`, `answering`, `done`, `error`).
- Finalize turn when `session/prompt` response arrives.

**Acceptance:** Golden tests using the spike fixture produce the expected final turn state.

### Task 3 — Semantic renderer components
**Owner:** NextPert  
**Files:** `src/renderer/components/AcpTranscript/*.tsx`

**Components:**
- `AcpTranscript` — scroll container with tail-follow and "new output" pill.
- `AssistantTurn` — Markdown prose with `react-markdown`, `remark-gfm`, `rehype-highlight`, Kimi-style `•` bullets and 4-space nested indent.
- `ThinkingBlock` — collapsible, dim italic, fixed toggle indentation.
- `ToolCallCard` — Bash/Read/Edit/Agent variants with spinner, status, expandable output/diff.
- `PlanCard` — plan/todo list rendering.
- `UserTurn` — user message bubble.
- `ActivityIndicator` — braille spinner for live thinking/tool activity.

**Requirements:**
- Feature-flag so only Kimi uses the ACP transcript; Claude/Codex stay on `UnifiedTerminal` fallback.
- Match native Kimi spacing, indentation, code blocks, diff cards.

**Acceptance:** QAPert compares screenshots to native `kimi-code` CLI and the known regression screenshots.

### Task 4 — Tool approval + chat/terminal polish
**Owner:** NextPert (primary), NextPert-Scout (support)  
**Files:** `src/main/acp/AcpRuntimeManager.ts`, `src/renderer/components/AcpTranscript/`, chat panel composer, `TerminalFooter`

**Requirements:**
- Correctly respond to `session/request_permission` with the verified nested outcome shape.
- Map to ACP Desktop autonomy/permission settings.
- Add explicit approval UI when auto-approve is off.
- Add footer activity indicators (model, tokens, status) from ACP events.
- Bind `Ctrl+C` to `session/cancel` for the active turn.
- **Deterministic user-turn rendering:** capture composer input and render it as a user bubble immediately; do not parse the agent output stream to find user messages.
- **Input history:** Up/Down arrows in the composer recall previous inputs.
- **Visual polish:** fix mid-word breaks, add color/font hierarchy, remove the AI sparkle from human messages, relocate/collapse inline token metadata, clean up thinking-block "…" clutter in both chat panel and terminal.

**Acceptance:**
- A prompt that triggers a shell command can be approved/rejected and the tool card updates.
- User messages always render as right-aligned bubbles.
- Up/Down recall previous inputs.
- No mid-word breaks in normal prose; human messages have no AI sparkle.

### Task 5 — QA acceptance
**Owner:** QAPert  
**Requirements:**
- Verify no `[ACP ...]` system lines or mail notifications in the ACP transcript.
- Verify thinking blocks do not fracture.
- Verify markdown lists, code blocks, diff cards match native Kimi.
- Verify existing tests pass; new tests cover transport, store, components.
- Verify `tsc --noEmit` and `vite build` are clean.

**Acceptance:** Sign-off in this WO.

---

## 5. Dependencies

- `kimi` CLI must support `kimi acp` on target environments (validated by Phase 0 spike).
- ACP Desktop composer input must route to ACP for Kimi and to PTY for others.
- No new backend cache work expected; DotNetPert is available if that changes.

---

## 6. Definition of done

- [x] Task 0 complete — feature branch `feature/WO-TERM-ACP-REDESIGN-20260708` created.
- [x] Task 1 complete — ACP transport integrated and tested.
- [x] Task 2 complete — turn-based store merged and golden-tested.
- [x] Task 3 complete — semantic renderer and `UnifiedTerminal` wiring done.
- [x] Task 4 complete — tool approval UI, footer indicators, deterministic user turns, input history, and chat/terminal visual polish.
- [ ] Task 5 complete — QAPert signs off.
- [x] `npm test` passes (297 tests, 1 skipped QA placeholder).
- [x] `npx tsc --noEmit` clean.
- [x] `npx tsc --noEmit -p tsconfig.main.json` clean.
- [x] `npm run build:electron` succeeds.
- [ ] Jon signs off.

---

## 7. Sign-off

| Role | Agent | Accepted | Date |
|---|---|---|---|
| Lead / Requirements | BAPert | ✅ | 2026-07-08 |
| Implementer — transport | NextPert-Scout | ✅ | 2026-07-08 |
| Implementer — store/renderer | NextPert | ✅ (branch skeleton up) | 2026-07-08 |
| Backend consultant | DotNetPert | ✅ | 2026-07-08 |
| QA | QAPert | ✅ (conditional) | 2026-07-08 |
| Stakeholder | Jon | ⬜ | |

---

## 8. Notes

- This WO supersedes ad-hoc terminal formatting patches. No further regex whack-a-mole without lead approval.
- If `kimi acp` proves unstable during implementation, immediately raise a blocker and fall back to the custom PTY-text-treatment path.
- Backend cache questions should route to DotNetPert.
- Implementation branch: `feature/WO-TERM-ACP-REDESIGN-20260708` on origin @ `286e1fa89d240bc41204b3e738d91ae185af03d4`. All build/test gates green; final integration verification pending NextPert report.
- Type consolidation resolved: canonical ACP IPC/event types live in `src/shared/acpTypes.ts`. Main forwards raw JSON-RPC `session/update` events to the renderer as `{ agent: string; sessionId: string; update: AcpSessionUpdate }`. The duplicate ACP block was removed from `src/shared/types.ts`.
- Renderer → main IPC payloads (BAPert decision 2026-07-08):
  - `ACP_PROMPT`: `{ agent, sessionId, text }` — main converts `text` into the content-block array `kimi acp` expects.
  - `ACP_CANCEL`: `{ agent, sessionId }`
  - `ACP_SET_MODE`: `{ agent, sessionId, mode }`
  - `ACP_KILL`: `{ agent, sessionId }`
  - `ACP_PERMISSION_RESPONSE`: `{ agent, sessionId, permissionRequestId, outcome, optionId? }` — main replies to the JSON-RPC request with `result: { outcome: { outcome, optionId } }`.
- Live `kimi acp` behavior verified 2026-07-08:
  - `session/new` requires `mcpServers: []`.
  - `session/prompt` expects `prompt` as an array of content blocks.
  - Permission response must be a JSON-RPC response (same `id`) with `result.outcome = { outcome: "selected", optionId }`.
  - `agent_thought_chunk` carries all assistant prose; `agent_message_chunk` was not observed. Renderer must fall back to rendering `thinking` as the main answer when `contentText` is empty.
  - `ACP_PERMISSION_RESPONSE`: `{ agent, sessionId, permissionRequestId, outcome, optionId? }`
- `session/permission_response` JSON-RPC shape sent to `kimi acp`: `{ requestId, outcome, optionId }`. Main maps `permissionRequestId → requestId` and passes through `outcome` (defaulting to `"selected"`).
- Kimi ACP feature flag in `UnifiedTerminal`: `effectiveProvider === 'kimi' && acpSession?.runtimeMode === 'acp'`. Claude/Codex continue to use the PTY line stream.
- Task 4 chat/terminal polish completed 2026-07-08:
  - Deterministic user turns: PTY composer now injects a `source: 'user'` line into `agentOutputStore` and calls `terminalStreamNormalizer.suppressEcho()` so provider echo does not re-render as agent output. ACP mode already captures user turns in `acpSessionStore`.
  - Composer Up/Down arrows recall per-agent/per-session input history via `useInputHistory` in both `UnifiedTerminal` and `ChatPanel`.
  - User bubbles use `break-words` (no mid-token breaks) and a stronger blue tint; agent prose uses larger/lighter text for hierarchy; thinking-block labels no longer append "…".
  - Token/context metadata stays in `TerminalFooter`; inline sparkle/status glyphs are stripped from captured user input by the echo-suppression path.
- Kimi API-key model-swap in Claude Code / Codex was considered and deferred. Moonshot exposes Anthropic/OpenAI-compatible endpoints, so Claude Code can point to `api.moonshot.ai/anthropic` and Codex can point to `api.moonshot.ai/v1` via a local compatibility layer. We deferred this because it outsources tool execution to the Claude/Codex clients, which would force us back into PTY-stream parsing to render tool cards and approval UI, and it would replace native Kimi UX with Claude/Codex UX. It remains a useful future runtime option but is out of scope for this WO.
