# ACP Desktop — Terminal Code Change Display

**Author:** BAPert  
**Status:** Draft — ready for review  
**Related:** `TERMINAL_PROVIDER_UNIFICATION_PRD.md`, `UnifiedTerminal.tsx`, `terminalStream.ts`

---

## 1. Context

When an agent emits code changes in the terminal chat pane, the output is currently rendered as raw inline text. Lines like diff markers (`+provider={effectiveProvider}`), line numbers (`| 483`), and file references (`Now modify TerminalPane.tsx...`) are splattered into the scrollback as plain prose, making it hard to read what actually changed.

Screenshot evidence: `E:\Repos\Agents\NextPert\codechanges.jpg`

## 2. Goal

Render agent-emitted code changes as structured, scannable blocks in the terminal output stream. Each block should show the target file path, the operation type, and the affected lines — not raw diff text mixed with prose.

## 3. Outcomes

- Code-change blocks are visually distinct from normal chat prose.
- Each block displays the file path and operation (e.g. "Modified", "Created", "Deleted").
- Diff lines are rendered in a monospace, bordered container with syntax-appropriate coloring (green add, red remove, gray context).
- Normal conversation lines are unchanged.

## 4. Non-goals

- We are not building a full syntax-highlighted code editor.
- We are not adding inline diff navigation (next/prev hunk).
- We are not changing how the agent emits output.

## 5. Proposed Solution

### 5.1 Detect code-change blocks in the normalized stream

Add a lightweight detector in `terminalStream.ts` (or a new `codeChangeDetector.ts`) that identifies sequences of lines emitted by the agent that describe edits. Heuristic signals:

- A preceding line mentions a file path and an operation:
  - `Now modify TerminalPane.tsx...`
  - `Creating src/main/newFile.ts`
  - `Delete E:\Repos\...\oldFile.ts`
- Consecutive lines start with diff markers or code-context markers:
  - `| 71 const foo = ...;`
  - `+  const bar = ...;`
  - `-  const baz = ...;`
- Tool-call markers like `Using StrReplaceFile` or `Using WriteFile` nearby.

### 5.2 Emit structured code-change lines

When a block is detected, emit a single structured line object that the renderer can format as a card:

```ts
interface CodeChangeLine {
  agent: string;
  terminal_id: string;
  ts: string;
  line: string; // display label, e.g. "Modified: TerminalPane.tsx"
  codeChange: {
    filePath: string;
    operation: 'modified' | 'created' | 'deleted';
    hunks: Array<{
      oldStart?: number;
      newStart?: number;
      lines: Array<{ type: 'context' | 'add' | 'remove'; text: string; lineNumber?: number }>;
    }>;
  };
}
```

Extend `AgentOutputLine` / `StreamLine` to carry an optional `codeChange` payload.

### 5.3 Render as a card in UnifiedTerminal

In `UnifiedTerminal.tsx`, when a line has `codeChange`, render it as a compact card instead of plain text:

- Header row: file path + operation badge + close/expand button.
- Body: `<pre>` block with colored rows:
  - add → green text (`text-emerald-400`)
  - remove → red text (`text-rose-400`)
  - context → muted text (`text-slate-500`)
- Collapse large diffs (>20 lines) by default, showing the first 10 lines with a "Show N more" button.

### 5.4 Preserve raw fallback

If detection is uncertain, fall back to rendering the lines as plain text. Do not misformat normal prose as code.

## 6. Acceptance Criteria

1. A sequence like the one in `codechanges.jpg` renders as a structured card with file path and operation.
2. Diff lines inside the card are colored (add/remove/context).
3. Normal chat lines are not affected.
4. Large diffs are collapsible.
5. Existing `terminalStream.test.ts` and `UnifiedTerminal.test.tsx` tests still pass.
6. New tests cover:
   - Detection of a code-change block
   - Extraction of file path and operation
   - Rendering of add/remove/context rows

## 7. Files to Modify

- `src/renderer/lib/terminalStream.ts` — add code-change detection
- `src/renderer/lib/terminalStream.test.ts` — add detection tests
- `src/renderer/components/Terminal/UnifiedTerminal.tsx` — render code-change cards
- `src/renderer/components/Terminal/UnifiedTerminal.test.tsx` — add rendering tests
- `src/renderer/stores/agentOutputStore.ts` — extend `AgentOutputLine` type

## 8. Suggested Phasing

**Phase 1 — Detection + basic card**
- Detect blocks, emit structured payload, render a simple bordered `<pre>` with file path header.

**Phase 2 — Polished card**
- Add operation badges, colored rows, collapse/expand, copy button.

**Phase 3 — Confidence tuning**
- Run against real agent sessions, tune heuristics, reduce false positives.

---

*Ready for review. BAPert will convert to work orders once direction is confirmed.*
