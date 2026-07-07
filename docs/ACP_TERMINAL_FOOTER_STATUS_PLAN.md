# Plan: Per-Agent Status Footer

## Goal

Turn the terminal pane footer into a live status dashboard by parsing metadata the provider already emits into the PTY stream, instead of dropping it as junk.

## Data We Want

| Field | Source | Priority |
|-------|--------|----------|
| Context usage % | `context: 38.5%` in stream | P0 |
| Token usage | `(101.9k/262.1k)` in stream | P0 |
| Current working directory | `E:\repos` in `yolo agent (...)` banner | P0 |
| Provider/model | `yolo agent (K2.7 Code •)` banner | P0 |
| Composing state | `Composing... <1s · 140 tokens` | P1 |
| Background tasks | Backend API (not in stream today) | P2 |

## Architecture

```
Provider PTY stream
        │
        ▼
TerminalStreamNormalizer
   │         │
   │         ▜─ extractStatus(metadata) ─▶ agentStatusStore
   │
   ▼
agentOutputStore (clean surface)
        │
        ▼
UnifiedTerminal ─▶ TerminalFooter
        │              ▲
        └──────────────┘
           reads agentStatusStore
```

## Implementation Steps

1. **Create `src/renderer/stores/agentStatusStore.ts`**
   - Zustand store keyed by `agentName`.
   - State per agent: `contextUsage`, `tokenUsed`, `tokenMax`, `cwd`, `model`, `provider`, `composing`, `lastSeenAt`.
   - Actions: `setStatus(agentName, partial)`, `clear(agentName)`.

2. **Extend `src/renderer/lib/terminalStream.ts`**
   - Add a `STATUS_EXTRACTORS` array of regex+extractor functions.
   - After classifying a line as footer noise, run extractors on the raw text.
   - Call `useAgentStatusStore.getState().setStatus(agent, extracted)` with any parsed values.
   - Keep dropping the raw line from the pane stream.

3. **Update `src/renderer/components/Terminal/TerminalFooter.tsx`**
   - Subscribe to `agentStatusStore` for the agent.
   - Display context %, token ratio, cwd, model/provider, composing state.
   - Fall back to stream-derived `agent.provider` and `repoPath` when store data is missing.

4. **Add regression tests**
   - `terminalStream.test.ts`: assert metadata is extracted from sample footer lines.
   - `agentStatusStore.test.ts`: assert store updates and clears correctly.

5. **Backend integration (P2)**
   - Later, add a hook that polls `/v1/agents/{name}/status` for `backgroundTasks` and overrides stream-derived values.

## Files to Touch

- `src/renderer/stores/agentStatusStore.ts` — new
- `src/renderer/lib/terminalStream.ts` — add extractors
- `src/renderer/components/Terminal/TerminalFooter.tsx` — display parsed data
- `src/renderer/components/Terminal/UnifiedTerminal.tsx` — pass agent name to footer
- `src/renderer/lib/terminalStream.test.ts` — add extractor tests
- `src/renderer/stores/agentStatusStore.test.ts` — new

## Implementation Status

Implemented in this session.

- `agentStatusStore.ts` created and tested.
- `terminalStream.ts` extractors parse context %, token usage, cwd, model, and composing state before dropping footer lines.
- `TerminalFooter.tsx` subscribes to the store and renders a single compact status line.
- `UnifiedTerminal.tsx` wired to the store and passes live context usage to the footer.
- Regression tests added/updated; latest run: 142 passing.

## Acceptance Criteria

- [x] No raw `yolo agent (...)` banners visible in terminal panes.
- [x] No raw `— input` prompts visible in terminal panes.
- [x] No raw keybinding hints (`ctrl-o: editor`, `/feedback: send feedback`, etc.) visible in terminal panes.
- [x] Extracted metadata (context %, tokens, cwd, model, composing) surfaces in the compact footer.
- [x] Stream-hygiene pass still drops all junk lines; extraction happens before the drop, not instead of it.
- [x] Footer remains one compact line per pane.

## Verification

- `npx tsc --noEmit` ✅
- `npm run test -- --run` ✅ (142 tests)
- `npx vite build` ✅
- Manual: reload app, open an agent pane, watch footer update as the agent runs.

## Risks

- Stream formats vary by provider/version; extractors must be tolerant.
- Parsing can fail silently; footer must degrade gracefully to previous placeholders.
- Multi-space variants of provider banners (e.g. `yolo  agent`) must be handled; regexes use `\s+` between tokens.
