# Terminal Provider Unification — Test Plan (Phase 1)

**Author:** Nextpert-Scout  
**Scope:** Adapter normalization + `UnifiedTerminal` scaffold.

---

## 1. Objectives

Verify that:
1. Provider adapters produce visually equivalent normalized output for the fixture corpus.
2. The stream normalizer collapses duplicates, spinner frames, and blank lines before lines reach the store.
3. `UnifiedTerminal` renders lines, scrolls, copies, pastes, forwards input, and resizes correctly.
4. Existing `AgentOutputPanel` behavior is not regressed.
5. PTY keystroke forwarding and resize reporting remain functional.

---

## 2. Unit-test coverage

### `ansi.test.ts`
- [x] `stripAnsi` removes SGR, 256-color, truecolor, cursor show/hide, erase-line, and OSC hyperlinks/titles.
- [x] Plain text is left unchanged.

### `terminalStream.test.ts`
- [x] ANSI is stripped and provider adapter is applied.
- [x] Consecutive Claude spinner frames collapse to one line.
- [x] Identical lines within 5 seconds are deduplicated.
- [x] The same line is allowed after the 5-second window.
- [x] Kimi `[IMAGE: ...]` placeholders are replaced with `⟨image⟩`.
- [x] Codex `codex-mini` / `codex-mini-latest` labels normalize to `Codex`.
- [x] Consecutive blank/whitespace-only lines are collapsed to at most two.

### `terminalProviderAdapters.ts` / `providerAdapter.test.ts`
- [x] Claude fixture: every plain-text `input`/`expected` pair passes.
- [x] Kimi fixture: every pair passes; image placeholders become `⟨image⟩`.
- [x] Codex fixture: every pair passes; model labels normalize to `Codex`.
- [x] Spinner glyphs are removed after ANSI has been stripped upstream.
- [x] Unknown provider falls back to the common normalization adapter.

### `UnifiedTerminal.test.tsx`
- [x] Renders only lines for the target agent.
- [x] Surface has `role="log"`, `aria-live="polite"`, and `tabIndex="0"`.
- [x] Printable keystrokes are forwarded to `writeTerminal`.
- [x] Ctrl+C with no selection forwards `\u0003` (SIGINT).
- [x] Ctrl+C with a selection copies the selected text.
- [x] Ctrl+V pastes via `window.electronAPI.readClipboardText()` and `writeTerminal`.
- [x] `resizeTerminal` is called with cols ≥ 10 and rows ≥ 4.

---

## 3. Manual QA checklist

### Adapters / fixtures
- [ ] Open each fixture JSON and confirm the `expected` output is visually readable.
- [ ] Run `npm test` and confirm all adapter + UnifiedTerminal tests pass.

### UnifiedTerminal scaffold
- [ ] Render `UnifiedTerminal` in a story or temporary route with each provider fixture.
- [ ] Confirm scrollback, tail-follow, and the new-output pill behave like `AgentOutputPanel`.
- [ ] Confirm text selection and `Ctrl+C` copy the selected text.
- [ ] Confirm `Ctrl+V` pastes into the PTY (terminal id must be active).
- [ ] Confirm Ctrl+C with no selection sends SIGINT to the running process.
- [ ] Resize the pane and verify `resizeTerminal` is called with scrollbar-aware cols/rows.

### Regression
- [ ] `AgentOutputPanel` continues to display the unified feed correctly.
- [ ] Existing `TerminalPane` (xterm.js) still starts, stops, resizes, and forwards input.
- [ ] No new runtime errors in the renderer or main-process console.

---

## 4. Known limitations / Phase 2+ work

- Full VT100 sequences are not emulated; only the ANSI patterns emitted by Claude/Kimi/Codex are stripped.
- `UnifiedTerminal` is not yet wired into `TerminalPane.tsx`; that is Phase 3.
- xterm.js dependencies remain in `package.json` until Phase 4 cleanup.
- Color preservation is deferred to Phase 2.

---

*Test plan aligned with implementation. Update checkbox state during validation.*
