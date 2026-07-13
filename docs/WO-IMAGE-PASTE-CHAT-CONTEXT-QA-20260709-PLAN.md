# QA Test Plan — WO-IMAGE-PASTE-CHAT-CONTEXT-QA-20260709

**WO:** Image Paste into Agent Chat Context — QA Execution  
**Epic:** `WO-IMAGE-PASTE-CHAT-CONTEXT-EPIC-20260709`  
**PRD:** `acp-desktop/docs/IMAGE_PASTE_TERMINAL_INPUT_PRD.md`  
**QA Owner:** QAPert  
**Branch:** `feature/WO-TERM-ACP-REDESIGN-20260708`  
**Status:** QA Prepared — pending implementation handoff sign-off

---

## 1. Objective

Verify that the image-paste feature for ACP-mode composers matches the approved PRD and Epic acceptance criteria:

- Images pasted into the ACP composer are staged silently (no preview) and sent as structured `AcpContentBlock[]` alongside text.
- The ACP runtime prompt path carries image content blocks and falls back to a markdown data-URI payload only when the runtime does not advertise image support.
- The ACP transcript renders user messages with `[pasted-image-N]` placeholders for attached images (no inline image rendering).
- Validation limits (10 MB, 4096×4096, 5 images) are enforced.
- Telemetry emits `image_paste_sent` / `image_paste_failed` per PRD §8.
- The legacy PTY image-paste temp-file path is removed.
- Existing tests continue to pass and new tests cover the feature.

---

## 2. Scope

### In scope
- Composer paste detection and silent attachment (`UnifiedTerminal.tsx`, `useTerminalImages.ts`).
- ACP-mode send path via `sendAcpMessage` with `AcpSendContentBlock[]`.
- `acpSessionStore` assembly of user turns with image content blocks.
- `UserTurn` / `AssistantTurn` transcript rendering of `[pasted-image-N]` placeholders.
- `AcpRuntimeManager.sendMessage` runtime capability detection and markdown fallback.
- Telemetry events `image_paste_sent` and `image_paste_failed`.
- Validation limits and inline error behavior.
- Removal of `src/main/lib/imagePaste.ts` and related temp-file PTY code.
- Build/test hygiene: `npm test`, `npx tsc --noEmit`.

### Out of scope
- Drag-and-drop file attachments.
- Non-image attachments.
- Cloud hosting / persistent attachment history.
- Image downscaling (Phase 2+).
- Image paste on the terminal log surface (composer only per PRD §4).

---

## 3. Test Environment

- **Repo:** `E:\repos\acp-desktop`
- **Branch:** `feature/WO-TERM-ACP-REDESIGN-20260708`
- **Source-of-truth spec:** ACP Document #2 (`GET /v1/documents/2`)
- **Key files under test:**
  - `src/renderer/components/Terminal/UnifiedTerminal.tsx`
  - `src/renderer/hooks/useTerminalImages.ts`
  - `src/renderer/components/AcpTranscript/UserTurn.tsx`
  - `src/renderer/components/AcpTranscript/AssistantTurn.tsx`
  - `src/renderer/stores/acpSessionStore.ts`
  - `src/main/acp/AcpRuntimeManager.ts`
  - `src/shared/acpTypes.ts`
  - `src/renderer/lib/telemetry.ts`

---

## 4. Test Cases

### 4.1 Composer Paste & Attachment (`UnifiedTerminal`, `useTerminalImages`)

| ID | Case | Steps | Expected | Result |
|---|---|---|---|---|
| C1.1 | Stage image pasted into ACP composer | Paste a PNG into the ACP composer input. | Image is staged; no preview UI is shown. A minimal attachment indicator may appear. | ✅ |
| C1.2 | Plain-text paste unchanged | Paste text into the composer. | Text is inserted at cursor; no attachment indicator. | ✅ |
| C1.3 | Mixed clipboard (image + text) | Paste clipboard containing both image and text. | Image staged; text appended to input; both ready to send. | ✅ |
| C1.4 | Attachment indicator shows count | Stage multiple images in ACP mode. | Optional attachment indicator displays the staged image count (no per-image remove buttons per PRD §6.2). | ✅ |
| C1.5 | Escape clears staged images | Press Escape with staged images. | All staged images and errors cleared. | ✅ |
| C1.6 | Unsupported format rejected | Paste a BMP image. | Inline error: format not supported; image not staged. | ✅ |
| C1.7 | Oversized file rejected | Paste a PNG with size > 10 MB. | Inline error: exceeds max file size; image not staged. | ✅ |
| C1.8 | Over-dimension image rejected | Paste a PNG whose width or height > 4096. | Inline error: exceeds max dimensions; image not staged. | ✅ |
| C1.9 | Max image count enforced | Attempt to paste a 6th image. | Inline error: at most 5 images; 6th image not staged. | ✅ |
| C1.10 | PTY mode ignores image paste | Paste an image in PTY mode. | Image ignored; plain-text behavior unchanged. | ✅ |
| C1.11 | Feature flag disables image paste | Disable `enableTerminalImagePaste`; paste an image. | Image ignored; plain-text behavior unchanged. | ✅ |

### 4.2 ACP Send Path (`UnifiedTerminal` → `acpSessionStore`)

| ID | Case | Steps | Expected | Result |
|---|---|---|---|---|
| S2.1 | Text + image sent as one message | Type text, stage image, press Enter. | `sendAcpMessage` called once with `content` array containing text block followed by image block. | ✅ |
| S2.2 | Image block carries base64 data | Inspect payload from S2.1. | Image block has `type: 'image'`, valid base64 `data`, correct `mimeType`. | ✅ |
| S2.3 | User turn created with image blocks | After send, inspect `acpSessionStore` turns. | User turn `content` contains text block plus image block(s); `contentText` contains only text. | ✅ |
| S2.4 | Input cleared after successful send | Send text + image. | Composer input empty; staged images cleared. | ✅ |
| S2.5 | Staged images retained on send failure | Reject `sendAcpMessage`; press Enter. | Inline error shown; staged images remain so user can retry. | ✅ |
| S2.6 | Empty send ignored | Press Enter with empty input and no images. | No `sendAcpMessage` / `sendAcpPrompt` call. | ✅ |
| S2.7 | Text-only ACP prompt unchanged | Press Enter with text only. | `sendAcpPrompt` called synchronously (existing text-only path preserved). | ✅ |

### 4.3 Runtime Prompt Path (`AcpRuntimeManager`)

| ID | Case | Steps | Expected | Result |
|---|---|---|---|---|
| R3.1 | Structured blocks forwarded when runtime supports images | Initialize runtime with `promptCapabilities.image: true`; call `sendMessage` with text + image. | `session/prompt` receives the exact text + image content blocks. | ✅ |
| R3.2 | Markdown data-URI fallback when runtime lacks image support | Initialize runtime without image capability; call `sendMessage` with text + image. | `session/prompt` receives a single text block containing `[Image pasted into chat context]`, the text, and a markdown `![Pasted image](data:...)` image. | ✅ |
| R3.3 | Plain text unchanged when no images and no image support | Call `sendMessage([{ type: 'text', text: ... }])` on runtime without image support. | `session/prompt` receives a single text block. | ✅ |
| R3.4 | Image block parsing from `agent_message_chunk` | Emit `agent_message_chunk` with nested image content block. | Event forwarded with `type: 'content', content: { type: 'image', data, mimeType }`. | ✅ |
| R3.5 | `sendMessage` before init throws | Call `sendMessage` before `start()` completes. | Throws `ACP runtime not initialized`. | ✅ |

### 4.4 Transcript Rendering (`AcpTranscript`, `UserTurn`, `AssistantTurn`)

| ID | Case | Steps | Expected | Result |
|---|---|---|---|---|
| T4.1 | User turn renders `[pasted-image-N]` placeholders | Render a user turn with text + image content blocks. | Text renders and `[pasted-image-1]` placeholder visible; no `<img>` tag. | ✅ |
| T4.2 | User turn replaces markdown data-URI with placeholder | Render a user turn whose `contentText` contains `![Pasted image](data:image/png;base64,...)`. | `[pasted-image-1]` placeholder shown with surrounding text preserved. | ✅ |
| T4.3 | Assistant turn renders image content blocks as placeholders | Render an assistant turn containing an image block. | `[pasted-image-1]` placeholder shown inside assistant bubble. | ✅ |
| T4.4 | Text-only user turn unchanged | Render a user turn with only text. | Existing bubble styling and behavior preserved. | ✅ |

### 4.5 Telemetry

| ID | Case | Steps | Expected | Result |
|---|---|---|---|---|
| M5.1 | Successful image send telemetry | Send an image in ACP mode. | `image_paste_sent` event emitted with `imageCount` and `totalSizeBytes`; no `provider` field. | ✅ |
| M5.2 | Failed image send telemetry | Reject `sendAcpMessage` and send. | `image_paste_failed` event emitted with `errorCode`. | ✅ |
| M5.3 | PTY image paste ignored | Attempt to send images in PTY mode. | No `image_paste_sent` / `image_paste_failed`; image is ignored. | ✅ |

### 4.6 Validation & Security

| ID | Case | Steps | Expected | Result |
|---|---|---|---|---|
| V6.1 | No file paths or temp files in ACP path | Inspect `sendAcpMessage` payload and `AcpRuntimeManager` code. | Image bytes travel as base64 in content blocks; no file path or temp-file write. | ✅ |
| V6.2 | Legacy temp-file code removed | Search for `imagePaste.ts` / temp-file image references. | `src/main/lib/imagePaste.ts` deleted; no remaining temp-file image-paste code. | ✅ |
| V6.3 | Validation limits enforced | Test 10 MB, 4096×4096, and 5-image limits. | All limits reject with inline errors per PRD §6.6. | ✅ |

### 4.7 Regression & Negative Cases

| ID | Case | Steps | Expected | Result |
|---|---|---|---|---|
| N7.1 | Existing PTY text behavior preserved | Run PTY-mode composer tests. | Text send, input history, Ctrl+C, Tab, Escape behave exactly as before. | ✅ |
| N7.2 | ACP text prompt unchanged | Send text-only message in ACP mode. | Uses `sendAcpPrompt` (not `sendAcpMessage`); input clears synchronously. | ✅ |
| N7.3 | `tsc --noEmit` clean | Run `npx tsc --noEmit`. | No type errors. | ✅ |
| N7.4 | Full test suite passes | Run `npm test`. | All tests pass; no new failures. | ✅ |
| N7.5 | No image bytes logged | Inspect telemetry and logging code. | Telemetry only logs `imageCount` / `totalSizeBytes`; no image data logged. | ✅ |

---

## 5. Accessibility Checks

| ID | Requirement | Verification | Result |
|---|---|---|---|
| A11.1 | Attachment indicator has `aria-label` indicating pasted image count. | Inspect DOM / test. | ✅ |
| A11.2 | No per-image remove buttons; any clear-all control has an accessible label. | Inspect DOM / test. | ✅ |
| A11.3 | Focus returns to composer after clearing staged images. | Manual / automated keyboard test. | ✅ |

---

## 6. Acceptance Checklist

- [x] `npm test` passes (baseline: 330 passed / 1 skipped).
- [x] `npx tsc --noEmit` clean.
- [x] Pasting an image into the ACP composer silently attaches it (no preview UI).
- [x] Pasting text in ACP mode continues to work exactly as before.
- [x] PTY mode ignores image paste.
- [x] Pressing Enter sends text + image as one ACP message.
- [x] Image bytes travel with the ACP message; no file paths or temp files are used.
- [x] The agent is informed that an image has been included (image block or `[Image pasted into chat context]` fallback).
- [x] The ACP transcript renders `[pasted-image-N]` placeholders for attached images.
- [x] Validation limits (10 MB, 4096×4096, 5 images) are enforced.
- [x] Telemetry emits `image_paste_sent` and `image_paste_failed` per PRD §8.
- [x] The PTY image-paste temp-file path is removed and no longer referenced.
- [x] New tests cover paste detection, message send, content-block transport, transcript placeholder rendering, and telemetry.
- [x] Accessibility attributes (`aria-label`, focus management) are present and correct.

---

## 7. Known Pending Items / Blockers

- **Branch consolidation:** The image-paste implementation currently lives on `feature/WO-TERM-ACP-REDESIGN-20260708`. The Epic expects distinct child WOs for renderer and runtime; confirm whether this branch will be renamed/rebased or whether the QA should be executed here.
- **PTY image paste behavior:** PTY mode ignores image paste. Verify the renderer does not call `window.electronAPI.sendTerminalWithImages` or any other PTY image-paste API, and that no image-paste telemetry is emitted for PTY-mode pastes.
- **Open PRD question #3 (oversized images):** Phase 1 rejects oversized images; Phase 2 may add downscaling. QA will enforce the current Phase 1 rejection behavior.

---

## 8. Sign-off

| Role | Agent | Status | Date |
|---|---|---|---|
| QA Test Plan | QAPert | ✅ Prepared | 2026-07-09 |
| Final QA Sign-off | QAPert | ✅ Approved (findings addressed and re-verified) | 2026-07-09 |
