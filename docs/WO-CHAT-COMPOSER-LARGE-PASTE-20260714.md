# Work Order: Chat Composer Large-Paste Collapse Fix

**WO ID:** WO-CHAT-COMPOSER-LARGE-PASTE-20260714  
**Status:** Open — Ready for implementation  
**Priority:** High  
**Owner / Lead:** BAPert  
**Implementer:** NextPert  
**QA:** QAPert  
**Stakeholder:** Jon  

---

## 1. Objective

Fix the ACP Desktop chat composer so a large collapsed paste can coexist with user-typed prompt text. The current implementation replaces the entire composer contents with the placeholder `[pasted code N lines]`, deleting any text the user has already typed and discarding the paste if the user adds an explanation after pasting. This causes real data loss and breaks the natural "prompt + code block" chat pattern.

The fix must preserve surrounding typed text on paste, keep the collapsed paste intact while the user types around it, and send the final message as the combined prompt plus the stored full paste text.

---

## 2. References

- Source report: NextPert mail to BAPert, 2026-07-14 (message_id `11117`)
- Primary file: `src/renderer/components/Terminal/UnifiedTerminal.tsx`
- Test file: `src/renderer/components/Terminal/UnifiedTerminal.test.tsx`
- Supporting files: `src/renderer/stores/acpSessionStore.ts`, `src/main/acp/AcpRuntimeManager.ts`

---

## 3. Scope

### In scope

- Composer paste behavior in `UnifiedTerminal` for both ACP and PTY modes.
- Large-paste collapse thresholds (`>= 5 lines` or `>= 1,000 chars`).
- Typed prompt text that appears before or after a collapsed paste.
- Send path that combines typed prompt + full paste text.
- Composer key handling (Backspace, Delete, Escape, Arrow keys, Enter, history recall).
- Unit-test updates and new regression tests.

### Out of scope

- Terminal-surface paste (`handleTerminalPaste` / `handlePasteFallback`); that path writes directly to the PTY and is unchanged.
- Multi-line composer or rich contenteditable composer.
- Copy/re-copy of the collapsed placeholder.
- Changes to image-paste staging behavior (image chips remain as-is).

---

## 4. Problem statement

Current behavior in `UnifiedTerminal.tsx`:

1. `insertTextAtCursor` large-paste branch sets `input.value = placeholder`, deleting any existing typed text.
2. `handleInputKeyDown` clears the placeholder and discards `pastedBlockRef.current.fullText` on any printable keystroke, Backspace/Delete, Escape, or history recall.
3. `sendInputLine` correctly sends `pastedBlockRef.current.fullText` when the placeholder is intact, but because the placeholder is destroyed by the actions above, the original large paste is lost whenever the user tries to add context.

---

## 5. Proposed UX / design decision

Treat the collapsed paste as an **atomic token** inside the existing single-line `<input>`:

- The composer is a sequence of typed text segments plus zero or one collapsed-paste block.
- A large paste is inserted at the cursor using `input.setRangeText` so text already in the composer is preserved.
- The collapsed block renders as the literal placeholder string `[pasted code N lines]` in the input value.
- The user can type before and after the placeholder; those typed characters are ordinary text.
- The collapsed block is **non-editable**: typing inside the placeholder itself is not supported. If the user edits the placeholder characters, the stored full text is discarded and only the raw input is sent.
- The block is removed as a unit:
  - **Backspace** when the caret is immediately after the block removes the entire block and its stored text.
  - **Delete** when the caret is immediately before the block removes the entire block.
  - **Escape** removes the block and keeps any typed text.
- **Arrow keys** move the caret; if movement would place the caret inside the placeholder, jump to the nearest placeholder boundary.
- **History recall (Up/Down)** should ideally preserve any typed text segments while replacing history, but at minimum must not silently discard a collapsed block. The safest behavior is to clear the block when history is recalled and warn via a console note or telemetry event.
- On **Enter**, if the placeholder is still intact, replace it with the stored `fullText` and send the combined string. If the placeholder has been edited/removed, send the raw input value.

This keeps the change localized to `UnifiedTerminal.tsx` and avoids a contenteditable rewrite.

---

## 6. Task breakdown and owners

### Task 0 — Spec / approach accepted
**Owner:** BAPert  
**Acceptance:** This WO is written and handed to NextPert.

### Task 1 — Composer state model refactor
**Owner:** NextPert  
**Files:** `src/renderer/components/Terminal/UnifiedTerminal.tsx`

**Requirements:**
- Extend `pastedBlockRef.current` to track:
  - `placeholder: string`
  - `fullText: string`
  - `start: number` — start index in the current input value
  - `end: number` — end index (exclusive)
- Refactor `insertTextAtCursor` so the large-paste branch uses `input.setRangeText(placeholder, start, end, 'end')` instead of `input.value = placeholder`.
- Add helpers to:
  - Recompute `start`/`end` after each input/keydown.
  - Detect whether the placeholder is still present and unchanged in `input.value`.
  - Remove the placeholder block from `input.value` while preserving surrounding text.
  - Replace the placeholder block with `fullText` at send time.

**Acceptance:** Existing unit tests for small-paste insertion still pass.

### Task 2 — Key handling
**Owner:** NextPert  
**Files:** `src/renderer/components/Terminal/UnifiedTerminal.tsx`

**Requirements:**
- Remove the current early-return logic that clears the block on every printable key, Escape, Backspace/Delete, and history recall.
- Backspace/Delete removes the whole block only when the caret is at the block boundary.
- Escape removes the block and keeps typed text.
- Arrow keys jump over the block instead of landing inside it.
- History recall clears the block (document the rationale).
- `handleInputInput` clears the block only when the placeholder substring is no longer present exactly once or has been altered.

**Acceptance:** Manual/keyboard tests: typing before and after the placeholder works; Backspace at boundary removes the chip; Escape removes the chip.

### Task 3 — Send path
**Owner:** NextPert  
**Files:** `src/renderer/components/Terminal/UnifiedTerminal.tsx`

**Requirements:**
- In `sendInputLine`, if a valid collapsed block exists and the placeholder is present in `input.value`, build `finalText` by replacing the placeholder with `fullText`.
- If the user typed prompt text, the final message order is: typed prompt, then the full paste. Use a single blank line (`\n\n`) between prompt and paste only when both are non-empty.
- If the placeholder has been corrupted, fall back to sending `input.value`.
- For ACP mode, pass the combined string to `startUserTurn` / `sendAcpPrompt` so `buildAcpSendBlocks` produces a single text block.
- For PTY mode, send the combined string via `writeTerminal`.
- Commit the combined string to input history.

**Acceptance:** New test: paste large text, type "explain this", press Enter — `mockWriteTerminal` or `mockSendAcpPrompt` receives `"explain this\n\n<full paste>"`.

### Task 4 — Test updates and regression tests
**Owner:** NextPert (implementation), QAPert (review)  
**Files:** `src/renderer/components/Terminal/UnifiedTerminal.test.tsx`

**Requirements:**
- Update existing collapse tests that currently expect `input.value = '[pasted code N lines]'` after paste to also cover cases where text already exists in the composer.
- Remove or update tests that assert the placeholder is cleared on Escape/Backspace/printable key; replace with new boundary-behavior assertions.
- Add regression tests for:
  - Existing typed text preserved after large paste.
  - Typing after large paste is kept.
  - Typing before large paste is kept.
  - Combined prompt + paste sent on Enter.
  - Large paste discarded when placeholder is edited.
  - Escape removes placeholder and keeps typed text.
  - Backspace at left boundary removes placeholder and keeps text after it.

**Acceptance:** `npm test -- src/renderer/components/Terminal/UnifiedTerminal.test.tsx` passes.

### Task 5 — QA acceptance
**Owner:** QAPert  
**Requirements:**
- Review the WO and the implemented behavior for consistency.
- Verify the full test suite (`npm test`) and type checks (`npx tsc --noEmit`, `npx tsc --noEmit -p tsconfig.main.json`) are clean.
- Manual spot-check in ACP mode: paste a 6-line snippet, type "explain", send, and confirm the assistant receives both parts.

**Acceptance:** Sign-off in this WO.

---

## 7. Dependencies

- No backend changes required.
- `acpSessionStore.ts` and `AcpRuntimeManager.ts` do not need changes if the combined string is passed into the existing `sendAcpPrompt` / `startUserTurn` text argument.

---

## 8. Definition of done

- [x] Task 0 complete — WO approved by BAPert.
- [x] Task 1 complete — composer state model supports prompt + collapsed paste.
- [x] Task 2 complete — key handling preserves the block until explicit removal.
- [x] Task 3 complete — send path combines typed prompt and full paste.
- [x] Task 4 complete — tests updated and new regression tests pass.
- [x] Task 5 complete — QAPert signs off.
- [x] `npm test` passes with no regressions (370/370 passed, 1 skipped).
- [x] `npx tsc --noEmit` clean.
- [x] `npx tsc --noEmit -p tsconfig.main.json` clean.
- [ ] Stakeholder (Jon) sign-off, if required.

---

## 9. Sign-off

| Role | Agent / Person | Accepted | Date |
|---|---|---|---|
| Lead / Requirements | BAPert | ✅ | 2026-07-14 |
| Implementer | NextPert | ⬜ | |
| QA | QAPert | ✅ | 2026-07-14 |
| Stakeholder | Jon | ⬜ | |

---

## 10. Notes

- Keep the single-line composer. Do not introduce a contenteditable surface unless this design proves infeasible during implementation — if it does, raise a blocker immediately.
- The placeholder must remain a literal string in the `<input>` value so screen readers and native input behaviors work without extra ARIA gymnastics.
- Telemetry events `composer_paste` and `composer_insert_text` already exist; preserve them and add a `combined` flag when a send includes both prompt and collapsed paste.
- If image paste and collapsed text paste are staged together, send them via `sendAcpMessage` / `buildAcpSendBlocks` as one text block followed by image blocks. The combined text block should contain the prompt + full paste.
