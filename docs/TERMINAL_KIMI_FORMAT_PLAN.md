# Terminal Kimi Format — Implementation Plan

**Status:** Review draft — pending Jon / team approval  
**Author:** BAPert  
**Implementers:** NextPert (primary), NextPert-Scout (support)  
**QA:** QAPert  
**Stakeholder:** Jon

---

## 1. Executive summary

Stop patching the PTY-stream regex normalizer. The real fix is to stop treating the provider TUI as a text stream we have to reverse-engineer, and instead consume the **structured event streams** the providers already emit.

For Kimi, that means using `kimi acp` — the first-class Agent Client Protocol (ACP) stdio JSON-RPC mode that IDEs like Zed use to drive Kimi sessions. ACP gives us clean, typed events for assistant text, thinking, tool calls, tool results, plans, and status. We render those events with components that match the native Kimi CLI look, not with regex-cleaned chat bubbles.

This plan:

1. Validates `kimi acp` works in our environment.
2. Builds a Kimi-only ACP runtime and renderer first.
3. Leaves a minimal, well-defined PTY fallback for Claude/Codex until their ACP/App-Server modes are ready.
4. Tears the current regex pile down to stubs in the fallback path only.

---

## 2. What we learned from research

### 2.1 How the mature CLIs really work

| CLI | Interactive renderer | Underlying stream | Headless / IDE mode |
|---|---|---|---|
| **Kimi Code** | Custom `pi-tui` framework | `kosong` → `agent-core` loop → typed `Event` union | `kimi acp` — ACP JSON-RPC over stdio |
| **Claude Code** | Custom React reconciler + Yoga/ANSI | Anthropic SDK events | `--output-format stream-json --input-format stream-json` (known raw-mode bug in recent versions) |
| **Codex CLI** | `ink` + React | OpenAI Responses API events | `codex app-server` — JSON-RPC over stdio |
| **Aider** | `prompt_toolkit` + `rich` | LiteLLM completions | Plain text only |

Key insight: the CLI vendors themselves **do not parse ANSI to build their UI**. They receive structured events and render them. Our current approach — spawning the CLI in a PTY and stripping ANSI — is backwards. We are re-inventing the parser the vendor already wrote.

### 2.2 What Kimi exposes via ACP

`kimi acp` is a stable subcommand (added v0.9.0, 2026-06-03). It speaks ACP v1 over stdio and supports everything a normal agent flow needs:

- `initialize` — capability negotiation
- `session/new`, `session/load`, `session/resume` — session lifecycle
- `session/prompt` — send user messages and stream responses
- `session/cancel` — interrupt a turn
- `session/set_mode`, `session/set_config_option` — mode/model switching
- `session/update` notifications — assistant text chunks, thinking chunks, tool calls, tool results, plans

Because it is designed for IDE integration, ACP keeps the protocol channel on stdout and logs on stderr. There is no TUI redraw noise, no spinner fracturing, and no ANSI orphan fragments to clean up.

### 2.3 What ACP means for ACP Desktop

If we speak ACP to Kimi:

- **No more ANSI stripping** for semantics (we may still need a tiny stripper for stderr or fallback PTY).
- **No more thinking-block fracture** — thinking arrives as `agent_thought_chunk` updates for a single turn.
- **No more colon-prefixed artifacts** (`:32`, `:47`) — those are TUI redraw fragments that do not exist in ACP.
- **No more ACP mail/system lines in the transcript** — mail is an ACP Desktop concern, not something we inject into the PTY stream.
- **Tool calls become first-class objects** — we get `tool_call`/`tool_call_update` notifications with title, status, and content, so we can render them as cards instead of parsing diff text.

---

## 3. Decision record

| Question | Decision |
|---|---|
| **Infer from source or custom text/activity treatment?** | **Infer from source.** Use `kimi acp` (ACP JSON-RPC) as the primary transport for Kimi. Custom rendering components adapt the structured events to ACP Desktop’s visual style. |
| **Scope** | **Kimi-first.** Build the ACP-driven renderer for Kimi. Architect it so Claude (`--output-format stream-json`) and Codex (`codex app-server`) can be added later, but do not block on them. |
| **Fallback** | Keep a **minimal PTY fallback** for providers without a working structured mode. Reduce the current normalizer to a small stub (ANSI strip, blank collapse, system-line drop) instead of growing it. |
| **Renderer** | Replace the line-printer transcript with a **turn-based semantic renderer**: `AssistantTurn`, `ThinkingBlock`, `ToolCallCard`, `PlanCard`, `UserTurn`, `ActivityIndicator`. |
| **Markdown** | Use the existing `react-markdown` + `remark-gfm` + `rehype-highlight` stack for assistant prose, aligned with Kimi native conventions (`•` bullets, 4-space nesting, dim italic thinking). |
| **xterm.js** | Do not remove it yet. Keep it as an opt-in/raw view until the ACP renderer is proven. The Terminal Provider Unification PRD goal of removing xterm.js becomes a follow-up after Kimi ACP is accepted. |

---

## 4. Target architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  Renderer (React)                                                            │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌─────────────────┐  │
│  │ UserTurn     │  │ AssistantTurn│  │ ThinkingBlock│  │ ToolCallCard    │  │
│  └──────────────┘  └──────────────┘  └──────────────┘  └─────────────────┘  │
│                              ▲                                              │
│                              │ AcpSessionStore (turn-based state)            │
├──────────────────────────────┼──────────────────────────────────────────────┤
│  Main ↔ Renderer IPC         │ ACP_EVENT, ACP_PROMPT                         │
├──────────────────────────────┼──────────────────────────────────────────────┤
│  Main process                │                                               │
│  ┌─────────────────────────────────────┐    ┌──────────────────────────┐    │
│  │ AcpRuntimeManager (per agent)       │    │ PtyRuntimeManager        │    │
│  │  • spawn `kimi acp`                 │    │  • node-pty fallback     │    │
│  │  • JSON-RPC stdio transport         │    │  • minimal normalizer    │    │
│  │  • route notifications to renderer  │    │  • legacy IPC path       │    │
│  │  • handle permission requests       │    │                          │    │
│  └─────────────────────────────────────┘    └──────────────────────────┘    │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 4.1 Main-process ACP runtime

A new `AcpRuntimeManager` per agent:

- Spawns the provider’s ACP entry point (e.g., `kimi acp`) with `stdio: ['pipe', 'pipe', 'pipe']`.
- Sends `initialize`, then `session/new` (or `session/load` when resuming).
- Exposes a `prompt(contentBlocks[])` method that sends `session/prompt`.
- Exposes `cancel()`, `setMode()`, `setConfigOption()`.
- Receives `session/update` notifications, parses them, and forwards typed events to the renderer over a new `ACP_EVENT` IPC channel.
- Handles agent-to-client requests such as `session/request_permission` by consulting ACP Desktop’s existing permission/autonomy settings and responding via JSON-RPC.
- Logs stderr to the existing platform log stream.

Because ACP agents may ask the client to perform filesystem or terminal operations, the runtime advertises **only the capabilities we want to delegate**. For the first slice we should advertise minimal client capabilities (`fs.readTextFile: false`, `fs.writeTextFile: false`, `terminal: false`) so Kimi continues to use its own internal Bash/Read/Edit tools and reports them via `tool_call` notifications. We can broaden capabilities later if we want ACP Desktop to act as the workspace broker.

### 4.2 Renderer turn-based state

A new `AcpSessionStore` (Zustand) holds per-agent session state as a list of **turns**, not lines:

```ts
interface Turn {
  id: string;
  agent: string;
  sessionId: string;
  turnId?: string;
  role: 'user' | 'assistant';
  status: 'idle' | 'thinking' | 'tool' | 'answering' | 'done' | 'error';
  content: ContentBlock[];
  thinking: string;
  toolCalls: ToolCall[];
  plan?: Plan;
  stopReason?: string;
  ts: string;
}
```

The store assembles streaming `session/update` deltas into turns:

- `agent_thought_chunk` → append to current turn’s `thinking`.
- `agent_message_chunk` → append to current turn’s `content`, status becomes `answering`.
- `tool_call` / `tool_call_update` → add or update a `ToolCall` in the current turn.
- `plan` → update the turn’s plan.
- `user_message_chunk` → append to the preceding user turn (ACP can stream user echo).

When the `session/prompt` response arrives with a stop reason, the turn finalizes.

### 4.3 Semantic renderer components

| Component | Source events | Native Kimi analog |
|---|---|---|
| `AssistantTurn` | `agent_message_chunk` finalized content | `AssistantMessageComponent` |
| `ThinkingBlock` | `agent_thought_chunk` | `ThinkingComponent` |
| `ToolCallCard` | `tool_call` / `tool_call_update` | `ToolCallComponent`, `ShellExecutionComponent` |
| `PlanCard` | `plan` | `TodoPanel` / plan entries |
| `UserTurn` | composer submit | user message bubble |
| `ActivityIndicator` | turn status, tool status | `MoonLoader` / braille spinner |

Rendering rules (derived from `pi-tui` source):

- Assistant prose is Markdown; use `react-markdown` with `remark-gfm` and `rehype-highlight`.
- Top-level assistant paragraphs get a `• ` bullet prefix like Kimi native output.
- Nested lists indent 4 spaces per level; unordered bullets render as `•`.
- Code blocks keep the terminal font stack and get syntax highlighting.
- Thinking text is dimmed, italic, and collapsible with a 2-line preview.
- Tool cards show a braille spinner while running, a checkmark/cross on completion, and expandable command/output/diff content.
- File edits use a diff card with green/red line backgrounds (reuse existing `CodeChangeCard` styling, but driven by ACP `Diff` content instead of regex-parsed PTY lines).

### 4.4 PTY fallback (minimal stub)

For Claude/Codex and any Kimi environment where `kimi acp` is unavailable:

- Keep `node-pty` and the live xterm.js pane.
- Reduce the normalizer to a **stub** with only:
  - ANSI stripping.
  - Blank-line collapse.
  - Drop lines matching `^\[ACP\b` and `^Failed to start:`.
  - Remove leading spinner glyphs.
- Remove the complex footer regex, thinking-block heuristics, code-change regex, and status extraction from the primary path.
- The fallback renderer remains the current `UnifiedTerminal` line transcript.

This fallback is intentionally bare; the visual investment goes into the ACP-driven renderer.

---

## 5. Phased implementation

### Phase 0 — Validate and stabilize (1–2 days)

1. **Commit or stash the current terminal work tree.** Do not build the redesign on top of uncommitted ad-hoc changes.
2. **Spike `kimi acp`.**
   - Spawn `kimi acp` from a standalone Node script.
   - Send `initialize` → `session/new` → `session/prompt`.
   - Capture a sample `session/update` stream for a simple prompt (e.g., "list files").
   - Confirm tool-call cards, thinking chunks, and final answer shapes.
   - Save captured fixtures under `src/renderer/lib/acp/__fixtures__/kimi/`.
3. **Confirm ACP Desktop can advertise minimal client capabilities** and still get Kimi to execute tools internally.
4. **Decision gate:** if `kimi acp` is unstable or missing on target environments, pivot to the PTY-fallback-plus-custom-renderer path.

### Phase 1 — ACP transport and turn state (2–3 days)

1. Add `@agentclientprotocol/sdk` **or** a small in-house JSON-RPC stdio client. The SDK is preferred if it runs in the Node/Electron main process; otherwise implement a thin NDJSON reader/writer.
2. Create `src/main/acp/`:
   - `AcpProcess.ts` — spawn, stdio plumbing, JSON-RPC request/response tracking.
   - `AcpRuntimeManager.ts` — lifecycle (init, session/new, prompt, cancel), notification routing, permission handling.
   - `providerConfigs.ts` — command/args/capabilities per provider.
3. Add IPC channels:
   - `ACP_EVENT` (main → renderer): `{ agentName, sessionId, event }`.
   - `ACP_PROMPT` (renderer → main): `{ agentName, contentBlocks }`.
   - `ACP_CANCEL`, `ACP_SET_MODE`, `ACP_KILL`.
4. Create `src/renderer/stores/acpSessionStore.ts`:
   - Assemble turns from streaming events.
   - Replace live placeholders in place (no line-printer dedup).
5. Wire the existing composer in `UnifiedTerminal` to send `ACP_PROMPT` when the active agent is in ACP mode.

### Phase 2 — Semantic renderer for Kimi (3–4 days)

1. Build components in `src/renderer/components/AcpTranscript/`:
   - `AcpTranscript.tsx` — scroll container, tail-follow, "new output" pill.
   - `AssistantTurn.tsx` — Markdown + bullet prefix + code highlighting.
   - `ThinkingBlock.tsx` — improve indentation using a flex row with fixed-width toggle so wrapped lines align with the label text.
   - `ToolCallCard.tsx` — Bash/Read/Edit/Agent variants.
   - `PlanCard.tsx`.
   - `UserTurn.tsx`.
2. Add a feature flag / provider switch so only Kimi uses the ACP transcript at first; Claude/Codex stay on the fallback.
3. Style to match native Kimi conventions (font stack already landed; tune spacing, indentation, colors).

### Phase 3 — Tool approval and polish (2–3 days)

1. Implement `session/request_permission` handling in `AcpRuntimeManager`.
   - Map to ACP Desktop’s existing autonomy/permission settings.
   - Surface explicit approval UI when required.
2. Handle `terminal/*` client methods if we later choose to delegate shell execution to ACP Desktop. For Phase 3, keep them disabled.
3. Add activity indicators in the pane footer (model, tokens, status) populated from ACP update events instead of regex-parsed PTY status lines.
4. Add keyboard shortcuts: `Ctrl+C` sends `session/cancel` for the active turn.

### Phase 4 — Cleanup and extension (future)

1. Remove or demote the legacy normalizer once Kimi ACP is the default.
2. Add Claude `--output-format stream-json --input-format stream-json` once the raw-mode startup bug is resolved or we find a stable invocation.
3. Add Codex `codex app-server` support.
4. Remove xterm.js and `terminalFit.ts` when all providers are on ACP and the raw view is no longer needed.

---

## 6. File-by-file change list (high confidence)

| File | Change |
|---|---|
| `src/main/acp/AcpProcess.ts` | New: JSON-RPC stdio transport. |
| `src/main/acp/AcpRuntimeManager.ts` | New: per-agent ACP lifecycle and event routing. |
| `src/main/acp/providerConfigs.ts` | New: provider launch configs (`kimi acp`, future Claude/Codex). |
| `src/main/pty.ts` | Spawn ACP process when provider supports it; otherwise keep PTY. |
| `src/main/preload.ts` | Add `ACP_EVENT` listener and `sendAcpPrompt`/`cancelAcp` APIs. |
| `src/renderer/stores/acpSessionStore.ts` | New: turn-based state from ACP events. |
| `src/renderer/components/AcpTranscript/*.tsx` | New: semantic transcript components. |
| `src/renderer/components/Terminal/UnifiedTerminal.tsx` | Route composer input to ACP or PTY based on agent mode; keep fallback rendering. |
| `src/renderer/lib/terminalStream.ts` | Reduce to minimal fallback stub; delete complex regexes in a later phase. |
| `src/renderer/lib/ansi.ts` | Keep; still needed for stderr/fallback PTY. |
| `docs/TERMINAL_KIMI_FORMAT_PLAN.md` | This document. |

---

## 7. Test strategy

| Layer | Tests |
|---|---|
| ACP transport | Unit tests for NDJSON parsing, request/response correlation, error handling. |
| ACP fixtures | Golden tests: feed captured `kimi acp` `session/update` arrays into `acpSessionStore` and assert final turn state. |
| Turn assembly | Test streaming assembly: thinking chunks merge, tool calls update, content chunks concatenate, stop reason finalizes. |
| Components | React Testing Library: `AssistantTurn` renders markdown; `ThinkingBlock` toggles; `ToolCallCard` shows spinner → success. |
| Fallback stub | Keep a small set of PTY normalizer tests for ANSI strip, blank collapse, ACP line drop. |
| E2E / manual | Run a real Kimi prompt through ACP Desktop and compare screenshot to native `kimi-code` CLI. |

---

## 8. Risks and mitigations

| Risk | Mitigation |
|---|---|
| `kimi acp` is not available or stable on installed CLI versions. | Phase 0 spike validates before any renderer work. PTY fallback remains. |
| ACP mode lacks a Kimi feature we rely on (e.g., plan mode, slash commands, skills). | Send slash commands as text prompts; use `session/set_mode` for plan mode; test skills early. |
| Tool approval flow is awkward in ACP Desktop autonomy model. | Phase 3 explicit approval UI; default to auto-approve under yolo settings. |
| Mixing ACP and PTY agents in the same view looks inconsistent. | Keep ACP renderer behind a provider flag; only Kimi uses it until others are ready. |
| Large refactor conflicts with current uncommitted terminal changes. | Commit/stash current work before starting; do not layer redesign on a dirty tree. |

---

## 9. Definition of done

- [ ] `kimi acp` spawns successfully and a sample prompt produces structured events.
- [ ] ACP-driven Kimi pane renders assistant text, thinking blocks, tool-call cards, and plans without regex artifacts.
- [ ] No `[ACP ...]` system lines or mail notifications appear in the ACP transcript.
- [ ] Thinking blocks do not fracture into single-line noise stacks.
- [ ] Markdown lists, code blocks, and diff cards visually match native Kimi conventions.
- [ ] Existing tests still pass; new tests cover ACP transport, turn assembly, and components.
- [ ] `tsc --noEmit` and `vite build` are clean.
- [ ] QAPert signs off against reference screenshots and the native CLI.

---

## 10. Immediate next step

Run the Phase 0 spike: capture a real `kimi acp` session from a standalone script and confirm the event shapes match the ACP schema. If the spike succeeds, schedule a round-table review of this plan with NextPert, NextPert-Scout, QAPert, and Jon. If it fails, we will fall back to the custom PTY-text-treatment path and revise the plan accordingly.
