# ACP Desktop — Image Paste into Terminal Input

**Author:** BAPert  
**Status:** Approved — work order issued  
**Related:** `SLASH_COMMANDS_PRD.md`, `TERMINAL_PROVIDER_UNIFICATION_PRD.md`

---

## 1. Context

The terminal chat input is now a clean, usable surface. Users naturally want to paste screenshots, diagrams, and error images directly into the input box so agents can see what they are describing. Today there is no way to attach an image to a prompt.

## 2. Goal

Let users paste images from the clipboard into any agent's message input with zero manual file handling. The user never copies a path or types an `/image` command — the app does that automatically.

## 3. Outcomes

- `Ctrl+V` of an image into the input box shows a thumbnail preview.
- Pressing Enter sends the image and any typed text to the active agent.
- The agent can reason about the image contents.
- The experience is consistent across Claude, Kimi, and Codex runtimes where supported.

## 4. Non-goals

- We are not building a general file-attachment system in this slice.
- We are not supporting drag-and-drop from the file system (yet).
- We are not uploading images to a central server or cloud storage.
- We are not adding image generation or editing.

## 5. User Flow

1. User copies an image to the clipboard (screenshot, browser image, etc.).
2. User focuses an agent's message input and presses `Ctrl+V`.
3. A thumbnail preview appears inline in the input box.
4. User optionally types text below the preview.
5. User presses `Enter`.
6. The app silently writes the image to a local temp file, builds the provider-specific command, and sends it to the agent's PTY.

**The user never sees the file path or types `/image`.**

## 6. Proposed Solution

### 6.1 Capture paste

Listen for the native `paste` event on the message input / composer element. If the clipboard data contains an image (`item.type.startsWith('image/')`), intercept it. Plain-text paste continues to work normally.

### 6.2 Render preview

Show a small inline thumbnail above the input text with:
- Image dimensions and file size
- A remove button (X)

Multiple pasted images stack horizontally with a max width; scroll if needed.

### 6.3 Store locally on send

When the user presses `Enter`, the renderer sends the staged image bytes to the main process over a dedicated IPC channel. The main process writes each image to a temp file:

```
<app-temp>/pasted-images/<agent>-<timestamp>-<n>.png
```

Images are normalized to PNG for consistency using Electron's native image conversion. The path is never shown to the user. The renderer does **not** know the temp path; only the main process does.

### 6.4 Send behavior

On `Enter`, the renderer sends a structured IPC message to the main process:

```json
{
  "terminalId": "...",
  "text": "what's wrong with this error?",
  "images": [
    { "id": "uuid", "name": "ClipboardImage.png", "type": "image/png", "data": "<ArrayBuffer>" }
  ]
}
```

The main process:

1. Validates the active terminal's provider (`claude`, `kimi`, or `codex`).
2. Writes each image blob to a temp PNG file.
3. Calls `src/main/lib/terminalInputAdapters.ts` to build the provider-specific PTY input.
4. Queues the resulting string through the existing `queuePtyWrite` path in `src/main/pty.ts`.

Phase 1 provider PTY output contract:

| Provider | Bytes written to PTY |
|----------|----------------------|
| **Claude Code** | Each quoted absolute image path on its own line, followed by the user's text. Claude Code auto-detects pasted image paths and attaches them. |
| **Kimi CLI** | Same as Claude Code: quoted absolute path(s) on their own line(s), followed by text. |
| **Codex CLI** | Same as Claude Code: quoted absolute path(s) on their own line(s), followed by text. |

Example of what reaches the PTY:

```
"/tmp/acp/pasted-images/BAPert-20260707-152200-0.png"
what's wrong with this error?
```

The provider CLI consumes the image. The user just typed `what's wrong with this error?` and hit Enter.

### 6.5 Instant-send option (Phase 2)

If the input box is empty when an image is pasted, send it immediately without waiting for extra text. This is configurable in settings and defaults to **off** so users can add context first.

*Moved to Phase 2 to keep Phase 1 focused on the core paste → preview → send flow.*

### 6.6 Cleanup

Pasted images are kept for 24 hours, then deleted by a background cleanup task. Users can also clear all pending previews with the Escape key or a remove button per image.

## 7. Size and Format Limits

| Limit | Value | Rationale |
|-------|-------|-----------|
| Max file size | 10 MB | Provider API ceilings and local storage |
| Max dimension | 4096 x 4096 | Common provider limit |
| Max images per message | 5 | Keeps payloads reasonable |
| Supported formats | PNG, JPEG, WebP, GIF | Broad provider support |

Images exceeding limits are rejected with a clear inline error in Phase 1. Downscaling may be added in Phase 2.

## 8. Security and Privacy

- Pasted images are stored only in the local app temp directory.
- They are never uploaded to ACP servers.
- They are readable only by the current user.
- Auto-delete after 24 hours.
- No image is sent until the user explicitly presses Enter (unless instant-send is enabled).

## 9. Acceptance Criteria

1. `Ctrl+V` of an image from the clipboard shows a thumbnail preview in the input box.
2. Pasting text continues to work unchanged.
3. Pressing Enter automatically saves the image to temp, builds the provider command, and sends it to the active agent.
4. The user never has to copy a path or type `/image`.
5. The active provider CLI receives the image in a way it can consume.
6. Images larger than 10 MB or 4096 x 4096 are rejected with a clear inline error in Phase 1; downscaling is deferred to Phase 2.
7. A remove button deletes the preview and removes the image from the pending message.
8. Pasted images are deleted from temp storage after 24 hours.
9. No image data is sent to ACP API endpoints or logged as base64.

## 10. Open Questions

1. Does Claude Code reliably auto-attach a quoted absolute image path in the PTY input, or do we need an explicit `/image <path>` command in Phase 2?
2. Does Kimi CLI auto-attach a quoted absolute image path, or does it require a specific command/placeholder?
3. Does Codex CLI auto-attach a quoted absolute image path in interactive mode, or does it require a specific attach command?

Decisions already incorporated into the spec:
- Instant-send defaults to **off** and is scoped to Phase 2.
- Image paste is supported on the **message input only** in Phase 1. Paste on the terminal log surface is out of scope.
- A plain-text image file path on the clipboard is treated as text, not read from disk, in Phase 1.

## 11. Suggested Phasing

**Phase 1 — One-step paste + automatic PTY passthrough**
- Capture paste, show thumbnail, auto-save on Enter, emit provider-specific image command.

**Phase 2 — Multi-image + instant-send setting**
- Allow up to 5 images, add instant-send toggle, scheduled cleanup.

**Phase 3 — Direct API mode**
- When running against provider APIs directly, inline base64 images instead of relying on CLI commands.

---

*Ready for review. BAPert will convert to work orders once direction is confirmed.*
