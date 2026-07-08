# Terminal Provider Unification — PRD

**Author:** BAPert  
**Status:** Implementation complete — pending QAPert source-run validation  
**Related:**
- Existing implementation: `Agent Terminal Output Stream` (ACP Mail thread, Nextpert-Scout msg 10466)
- Code: `acp-desktop/src/renderer/components/AgentOutput/AgentOutputPanel.tsx`, `src/renderer/stores/agentOutputStore.ts`, `src/main/ptyOutputReporter.ts`
- Related fix: WO 92267 terminal-fit reports (`Agents/QAPert/reports/wo-92267-rebuild-ready-status-20260629.md`)

---

## 1. Context

There are two overlapping terminal efforts in flight:

1. **Agent Terminal Output Stream** (already implemented as a first slice by Nextpert-Scout, msg 10466). It forwards node-pty output from acp-desktop → acp-api → renderer SSE → `AgentOutputPanel`, a side-panel chat-style feed. This currently runs **parallel** to the existing `xterm.js` terminal panes.
2. **Terminal provider unification** (this PRD). The goal is to remove `xterm.js` as the renderer for the per-agent terminal panes and replace it with an ACP-owned surface so Claude/Kimi/Codex output behaves identically.

This PRD treats the Agent Output Stream as the foundation and defines the next phase: extending the normalized-output pipeline so it can also drive the main terminal panes, ultimately letting us drop `xterm.js`.

## 2. Problem

`TerminalPane.tsx` uses `xterm.js` to render PTY output. Because each provider CLI emits different ANSI sequences, cursor patterns, and TUI behaviors, the four-pane experience is inconsistent:

- Claude, Kimi, and Codex render progress spinners, helper text, and reflow differently.
- `xterm.js` is a heavy, full VT emulator that is hard to customize and forces defensive fit/scrollback workarounds (`terminalFit.ts`).
- Provider-specific quirks leak into layout and copy/paste behavior.

## 3. Goal

Remove the `xterm.js` renderer dependency from `TerminalPane` and replace it with a lightweight, ACP-owned terminal surface that normalizes output across Claude, Kimi, and Codex while preserving required terminal interactions.

## 4. Outcomes

- `xterm`, `xterm-addon-fit`, and `xterm-addon-web-links` are removed from `package.json`.
- The main terminal panes render provider-normalized output.
- PTY input/output/resize/copy/paste continue to work for every supported provider.
- Scrollback, focus, and layout behavior are at least as good as today.

## 5. Non-goals

- We are **not** replacing `node-pty`; it remains the process/PTY authority in the main process.
- We are **not** removing the `AgentOutputPanel`; it becomes the canonical normalized feed and may replace or coexist with per-pane terminals depending on layout decisions.
- We are **not** building a full VT100/ANSI emulator. We intentionally scope the parser to the escape sequences our three providers actually emit.

## 6. Proposed Solution

### 6.1 Reuse the existing normalized-output pipeline

The Agent Output Stream already:
- Taps `node-pty` output in `src/main/pty.ts` via `reportPtyOutput()`.
- Batches and forwards it through `src/main/ptyOutputReporter.ts`.
- Receives `agent-output` SSE events in `src/renderer/hooks/useAcpSse.ts`.
- Stores lines in `src/renderer/stores/agentOutputStore.ts`.
- Renders them in `src/renderer/components/AgentOutput/AgentOutputPanel.tsx`.

We extend this pipeline so the same normalized line stream can feed the per-agent terminal panes.

### 6.2 New `UnifiedTerminal` renderer

Create a new `UnifiedTerminal` component (or evolve `AgentOutputPanel`) that:

1. Receives the pre-normalized line stream from `agentOutputStore` for a single agent.
2. Does not re-apply provider adapters (they ran upstream before the store); instead renders the stored lines directly.
   - Claude: helper-textarea focus races, progress spinner frames.
   - Kimi: inline image placeholders, excessive blank-line collapse.
   - Codex: status-line normalization, 24-bit color coercion to theme palette.
3. Renders lines as styled DOM elements inside a scrollable, focusable container.
4. Sends user keystrokes back through the existing `writeTerminal` IPC.
5. Supports copy/paste and selection via native browser APIs.

### 6.3 Replace `TerminalPane` renderer

Update `TerminalPane.tsx`:
- Remove `xterm`, `xterm-addon-fit`, `xterm-addon-web-links`.
- Replace the `xterm.js` instance with `UnifiedTerminal` bound to the agent's terminal ID.
- Keep the pane chrome (header, start/stop/restart controls, runtime badge, focus behavior).
- Keep resize handling but simplify it: measure container and report cols/rows to PTY via `resizeTerminal` IPC.

### 6.4 Layout and fit

Replace `xterm-addon-fit` + `terminalFit.ts` with a ResizeObserver-based fit:

```
cols = floor((hostWidth - padding) / charWidth)
rows = floor((hostHeight - padding) / lineHeight)
```

Use a hidden measurement element with the same font settings. Clamp to `MIN_COLS = 10`, `MIN_ROWS = 4`.

### 6.5 Provider adapters

Each adapter is a pure function `string -> string` selected by the active project's `runtime_choice` (already shown in the runtime badge). Adapters run on the renderer side after the line is received from SSE.

### Phase 1 implementation decisions

- **Adapter location:** `src/renderer/lib/terminalProviderAdapters.ts`.
- **ANSI stripping location:** `src/renderer/lib/ansi.ts`, applied upstream before lines are stored in `agentOutputStore`. Currently this happens in `src/renderer/hooks/useVsqlCacheSse.ts`; once the PayEzVibe API contract is implemented, the SSE consumer will be updated to strip ANSI from the PayEzVibe API stream before storage. This keeps `AgentOutputPanel` and `UnifiedTerminal` on the same clean line stream.
- **Fixture corpus:** `src/renderer/lib/terminalAdapters/__fixtures__/{claude,kimi,codex}-session.json`. Each fixture contains **plain-text** PTY lines (ANSI already removed) and their expected adapter-normalized output.
- **Adapter contract:** Adapters are pure `string -> string` functions that operate on plain text. They normalize **structural provider quirks**, not ANSI escape sequences.
- **Stream normalizer:** `src/renderer/lib/terminalStream.ts` runs after adapters and before `agentOutputStore`. It applies provider adapters, drops blank lines, collapses consecutive spinner frames, deduplicates identical lines within 5 seconds, and replaces Kimi image placeholders with `⟨image⟩`.
- **Spinner normalization:** Remove leading Unicode braille/progress glyphs (`⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏⠛⠶⠮⠵`, `◐◓◑◒◉`) so consecutive frames collapse to the same text.
- **Kimi-specific:** Replace `[IMAGE: ...]` placeholders with `⟨image⟩`.
- **Codex-specific:** Normalize `codex-mini` / `codex-mini-latest` to `Codex`.
- **Blank-line handling:** Empty and whitespace-only lines are dropped upstream so both `AgentOutputPanel` and `UnifiedTerminal` behave identically.
- **Status lines:** Preserve structural characters (box drawing, checkmarks); color is removed upstream, so visually equivalent output remains.

## 6.6 UnifiedTerminal component

`src/renderer/components/Terminal/UnifiedTerminal.tsx` is the reusable scaffold for Phase 1. It:

- Subscribes to `agentOutputStore` and filters lines for a single agent.
- Applies the provider adapter (`getTerminalAdapter(provider)`).
- Renders lines as styled DOM rows with timestamps.
- Supports scrollback with tail-follow and a "New output below" pill when the user scrolls up.
- Supports copy/paste via selection, `Ctrl+C`, `Ctrl+V`, and right-click context menu.
- Forwards keystrokes to PTY via `writeTerminal`.
- Uses a hidden measurement span + `ResizeObserver` to compute cols/rows and reports them to PTY via `resizeTerminal` within ~100 ms.
- Clamps dimensions to `MIN_COLS = 10` and `MIN_ROWS = 4`.

## 7. Acceptance Criteria

1. `xterm`, `xterm-addon-fit`, and `xterm-addon-web-links` are removed from `package.json` and no longer imported in `TerminalPane.tsx`.
2. `TerminalPane` renders using `UnifiedTerminal` and produces visually consistent output for Claude/Kimi/Codex.
3. Resizing a pane updates PTY cols/rows through `resizeTerminal` IPC within 150 ms.
4. Copy and paste work with keyboard shortcuts and right-click for all three providers.
5. Scrollback/tail-follow behavior matches current behavior (auto-follow at bottom, pause on scroll-up, "New output below" pill).
6. The `AgentOutputPanel` continues to work as the unified overview feed.
7. No regression in startup time or memory usage.

## 8. Decisions

| Topic | Decision |
|---|---|
| **Color handling (Phase 1)** | `TerminalOutputBridge` strips ANSI; adapters operate on plain text. Color preservation is deferred to Phase 2. |
| **Kimi image placeholder** | Replace with `⟨image⟩`. |
| **Codex model label** | Keep but normalize `codex-mini` / `codex-mini-latest` prefixes to `Codex`. |
| **Adapter ordering** | Adapters run before lines reach `agentOutputStore`; both `AgentOutputPanel` and `UnifiedTerminal` consume post-adapter lines. |
| **Fixtures** | Synthetic fixtures first; real captures added only where needed. |

## 9. Risks

1. **ANSI surface scope:** Do providers emit sequences outside the scoped list (alternate screen buffer, mouse tracking, sixel)?
2. **Performance:** Large scrollback with DOM rendering may need virtualization.
3. **Accessibility:** Need an equivalent screen-reader structure for the replaced terminal.
4. **Layout coexistence:** Does `UnifiedTerminal` replace per-pane terminals entirely, or does `AgentOutputPanel` become the primary view and terminal panes become optional?

## 10. Suggested Phasing

**Phase 1 — Corpus + provider adapters** ✅ In progress
- Fixture corpus captured under `src/renderer/lib/terminalAdapters/__fixtures__/`.
- Adapter rules implemented in `src/renderer/lib/terminalProviderAdapters.ts`.
- `UnifiedTerminal.tsx` scaffolded and unit-tested.

**Phase 2 — UnifiedTerminal component**  
Nextpert-Scout extracts/evolves a reusable `UnifiedTerminal` from `AgentOutputPanel`.

**Phase 3 — TerminalPane swap**  
Nextpert-Scout replaces the xterm.js instance in `TerminalPane` with `UnifiedTerminal`.

**Phase 4 — Cleanup and removal**  
QAPert verifies acceptance; Nextpert-Scout removes xterm.js dependencies and `terminalFit.ts` if no longer needed.

## 11. Dependencies

- **PayEzVibe API contract:** The locked endpoint specification is `PayEz-Core/PayEz.Apis/PayEz.Vibe.Public.Api/docs/PAYEZVIBE_AGENT_OUTPUT_API_SPEC.md` (owner: DotNetPert). It defines `POST /v1/agent-output` and `GET /v1/agent-output/stream`, the bearer-token + `agent_terminal_output` capability auth model, the 93-first rollout plan, and the acp-desktop migration impact.
- **Direct vsql-cache removal:** Once the PayEzVibe API endpoint is deployed on 93 and the IDP capability is configured, `acp-desktop` will repoint `ptyOutputReporter.ts` to `{VIBE_API_URL}/v1/agent-output`, replace `useVsqlCacheSse.ts` with a PayEzVibe API SSE consumer, and delete `vsql-cache-client.ts` plus the `VIBESQL_CONTAINER_SECRET` / `VSQL_CACHE_URL` env vars.
- The Agent Output Stream renderer pipeline (`AgentOutputPanel`, `agentOutputStore`) is the foundation.
- Requires access to real or recorded sessions for all three providers.

---

*Ready for review. BAPert will convert to work orders once direction is confirmed.*
