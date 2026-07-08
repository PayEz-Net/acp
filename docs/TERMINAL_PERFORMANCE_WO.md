> **Implementation status:** Implemented by Nextpert-Scout — 197/197 tests passing.  
> This work order is posted here as a durable reference for the ACP Desktop project.
# Work Order — ACP Desktop Terminal Renderer Performance

**WO ID:** WO-TERM-PERF-20260707  
**Author:** BAPert  
**Assigned to:** NextPert  
**Reviewer:** QAPert  
**Priority:** P1 — terminal responsiveness  
**Status:** Approved — QAPert PASS; ready for implementation

---

## 1. Problem

ACP Desktop terminal UX feels sluggish under load:

- Pasting a medium-sized Markdown block or a long URL into the terminal input takes roughly a 10-count (~10 s) before it appears.
- Typing into the composer slows or stalls when the terminal surface is busy receiving PTY output.
- The renderer drops frames while scrolling or updating a large scrollback buffer.

## 2. Goal

Make the terminal input path and output rendering path responsive regardless of scrollback size or PTY traffic rate. End-to-end paste latency for a 5,000-character block should be <500 ms, and typing should stay at ≥30 fps while output is streaming.

## 3. Outcomes

- Large text / URL paste no longer blocks the UI thread.
- Typing into a busy terminal stays smooth.
- Scrolling a 1,000-line terminal pane stays at ≥30 fps (ideally 60 fps).
- React DevTools Profiler shows terminal components no longer re-render on unrelated store changes.

## 4. Non-goals

- Rewriting the PTY server or main-process IPC layer.
- Adding network-level throughput improvements.
- Changing the terminal feature set (image paste, code-change cards, thinking footer, etc.) except where required for performance.

## 5. Root-Cause Findings

Ranked by likely impact:

1. **Unvirtualized full-buffer rendering.** `UnifiedTerminal.tsx` and `AgentOutputPanel.tsx` map every line in the scrollback to a DOM node on every update. With `MAX_DEFAULT = 1000` lines and multiple panes visible, each new PTY chunk forces React to reconcile thousands of nodes.
2. **Per-line store churn.** `agentOutputStore.addLine` copies the entire `lines` array for every new line (`[...state.lines]`). `useVsqlCacheSse.ts` calls it once per SSE event, so a busy PTY triggers hundreds of O(n) array copies per second.
3. **Broad Zustand subscriptions.** `TerminalGrid.tsx` and `AgentOutputPanel.tsx` destructure the entire store object, causing re-renders on unrelated mutations (sidebar toggles, backend status, etc.).
4. **Expensive derived state on every render.** `UnifiedTerminal.tsx` recomputes `filteredLines`, `lineCount`, `thinkingCount`, and `isThinkingLive` from the full `lines` array each render.
5. **Blocking clipboard round-trip.** `handlePaste` in `UnifiedTerminal.tsx` calls `window.electronAPI.readClipboardText()` (an `ipcRenderer.invoke` round-trip to the main process) synchronously before writing to the PTY. When the main process is busy, the renderer waits.
6. **Layout-thrashing auto-scroll.** A `useEffect` runs `el.scrollTop = el.scrollHeight` after every `filteredLines` change, forcing synchronous layout on a large DOM.
7. **Per-line stream normalizer cost.** `terminalStream.ts` prunes `recentKeys` and runs global regex replacements on every normal line.

## 6. Proposed Solution

### 6.1 Virtualize the line lists (highest impact)

Use a virtualization library (`react-window` or `@tanstack/react-virtual`) in both `UnifiedTerminal.tsx` and `AgentOutputPanel.tsx`. Render only visible lines plus overscan. Keep the existing line renderer JSX; wrap it in a virtual list row component.

- Stable line keys: add a unique `id` to each `AgentOutputLine` at creation time and use it as the React key instead of `${line.ts}-${idx}`.
- Preserve auto-scroll by anchoring to a bottom sentinel element inside the virtual list.

### 6.2 Batch store updates

Change `useVsqlCacheSse.ts` to collect normalized lines for up to 50 ms and call a new `addLines(batch)` method on `agentOutputStore`. Add `addLines` to `agentOutputStore.ts` that appends the batch with a single array copy and single prune pass.

Until virtualization lands, lower `MAX_DEFAULT` from 1000 to 250–500 as a quick win.

### 6.3 Narrow Zustand selectors

Replace whole-store destructuring in `TerminalGrid.tsx` and `AgentOutputPanel.tsx` with narrow selectors. Example:

```tsx
const layout = useAppStore((s) => s.layout);
const focusAgent = useAppStore((s) => s.focusAgent);
```

In `UnifiedTerminal.tsx`, select only the current agent’s lines (or use a shallow-equal selector) so unrelated agents’ output does not re-render this pane.

### 6.4 Debounce footer stats

Move `lineCount`, `thinkingCount`, and `isThinkingLive` computation into a debounced effect (100 ms) so footer metadata does not recompute on every render during a burst.

### 6.5 Remove blocking clipboard read from Ctrl+V

For plain-text paste, use the browser’s native `paste` event to get `event.clipboardData.getData('text/plain')` directly in the renderer. Avoid the main-process `readClipboardText` round-trip on the critical input path. If the main-process read is still required for some cases, wrap it in a non-blocking async handler and show a brief “pasting…” indicator.

### 6.6 Make auto-scroll non-blocking

Replace the direct `scrollTop = scrollHeight` mutation with `requestAnimationFrame`. Only auto-scroll when the user is already near the bottom (already partially implemented; tighten the threshold). Use `scrollIntoView({ behavior: 'auto', block: 'end' })` on the bottom sentinel.

### 6.7 Reduce stream normalizer per-line cost

- Prune `recentKeys` once per second instead of on every normal line.
- Cache `collapseKey` results in an LRU keyed by the input string.
- Keep the joined thinking preview cached and invalidate only when `thinkingBuffer` changes.

### 6.8 Add perf instrumentation

Add `performance.now` markers around:
- `agentOutputStore.addLine` / `addLines`
- `filteredLines` computation in `UnifiedTerminal.tsx`
- `handlePaste` clipboard read + PTY write

These are temporary diagnostic logs; they can be removed or gated behind `process.env.NODE_ENV === 'development'` after validation.

## 7. Acceptance Criteria

1. Pasting 5,000 characters of Markdown into the terminal input completes end-to-end in <500 ms on a dev build.
2. Typing characters into the composer while the terminal is streaming stays at ≥30 fps (measured via Chrome DevTools Performance / React Profiler).
3. Scrolling a 1,000-line terminal pane stays at ≥30 fps.
4. `TerminalGrid.tsx` and `AgentOutputPanel.tsx` no longer re-render when unrelated store fields change (verified via React DevTools Profiler “why did this render?”).
5. `agentOutputStore` updates a 1,000-line buffer with a 100-line burst in <50 ms total.
6. All existing tests pass:
   - `npx vitest run src/renderer/components/Terminal/UnifiedTerminal.test.tsx`
   - `npx vitest run src/renderer/components/Terminal/TerminalPane.test.tsx`
   - `npx vitest run src/renderer/lib/terminalStream.test.ts`
7. At least one new regression test is added for the batch update path or paste latency.

## 8. Files to Modify / Create

- `src/renderer/components/Terminal/UnifiedTerminal.tsx`
- `src/renderer/components/Terminal/AgentOutputPanel.tsx`
- `src/renderer/components/Terminal/TerminalGrid.tsx`
- `src/renderer/stores/agentOutputStore.ts`
- `src/renderer/hooks/useVsqlCacheSse.ts`
- `src/renderer/lib/terminalStream.ts`
- `src/main/preload.ts` (if clipboard API needs adjustment)
- `src/main/index.ts` (if clipboard handler needs adjustment)
- New perf-instrumentation helpers (optional): `src/renderer/lib/perf.ts`

## 9. Test Commands

```powershell
cd E:\Repos\acp-desktop
npx tsc --noEmit
npx vitest run src/renderer/components/Terminal/UnifiedTerminal.test.tsx
npx vitest run src/renderer/components/Terminal/TerminalPane.test.tsx
npx vitest run src/renderer/lib/terminalStream.test.ts
```

## 10. Risks and Notes

- Virtualization changes how `scrollHeight` and scroll position are calculated; test auto-scroll behavior carefully.
- Batch updates may slightly delay visible output by one frame; keep the batch window ≤50 ms.
- Stable line IDs are required for React keys; ensure `id` is generated before the line is first rendered.
- Do not remove existing accessibility attributes (alt text, aria-labels) while refactoring line rendering.

---

**NextPert:** Approved — begin implementation.  
**QAPert:** PASS recorded; re-review on Scout's final PR.
