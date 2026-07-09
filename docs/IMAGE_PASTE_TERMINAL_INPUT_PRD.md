# Image Paste into Agent Chat Context

**Author:** BAPert  
**Status:** Draft v4 — unified chat-context design, no file paths  
**Last updated:** 2026-07-09  

---

## 1. Context

Agent interaction now happens through a unified, bridged chat stream. Users type into a composer; the message joins the agent’s chat context; the agent replies in the same stream. Image paste must fit this model naturally.

The old workaround — save the image, copy the file path, paste the path — is dead. The new expectation is: paste the image directly, the app attaches it to the message, and the agent can read it from the chat context.

## 2. Goal

When a user pastes an image into an agent composer, the image is read from the clipboard, attached to the outgoing message, and delivered to the agent as part of the chat context. The agent is explicitly told an image has been included and can reason about it.

The user never saves a file, copies a path, or types an image command.

## 3. Outcomes

- `Ctrl+V` of an image into the composer shows an inline thumbnail preview.
- Pasting text continues to work exactly as before.
- Pressing Enter sends the message with the image attached to the chat context.
- The transcript shows the user message and the attached image(s).
- The agent receives explicit notice that an image has been included.

## 4. Non-goals

- General file attachments (non-image files).
- Drag-and-drop from the file system.
- Cloud upload or external image hosting.
- Image generation or editing.
- Image paste on the terminal log surface (composer only).

## 5. User Flow

1. User copies an image to the clipboard.
2. User focuses an agent composer and presses `Ctrl+V`.
3. A thumbnail preview appears inline above the text input.
4. User optionally types text.
5. User presses `Enter`.
6. The app sends the text + image to the agent as one chat message.
7. The transcript shows the user text and the image.
8. The agent sees the image in its chat context and can reference it.

## 6. Detailed Design

### 6.1 Read the image from the paste

The composer listens for the native `paste` event.

- If `event.clipboardData.items` contains an image (`item.type.startsWith('image/')`), read the `Blob`/`File` into an `ArrayBuffer`.
- Stage the image for preview and send.
- Let plain-text paste fall through to existing behavior.
- If both image and text are on the clipboard, stage the image and append the text to the input.

### 6.2 Preview

Reuse the existing staging hook:

- Thumbnail strip above the input.
- Dimensions and file size.
- Remove button per image.
- Limit to 5 images per message.
- Escape clears all previews.

### 6.3 Attach the image to the chat message

On Enter, the composer sends a single message containing text and one or more images. The image bytes travel with the message; no file path is ever written to disk or shown to the agent.

Recommended approach: encode each image as base64 and include it as a structured content block alongside the text:

```ts
[
  { type: 'text', text: "what's wrong with this error?" },
  { type: 'image', data: '<base64>', mimeType: 'image/png' }
]
```

If the current agent runtime only accepts a single text payload, embed the image as a markdown data URI and add an explicit preamble:

```markdown
The user has pasted an image into the chat context:

![Pasted image](data:image/png;base64,iVBORw0KGgo...)

what's wrong with this error?
```

The exact wire format is an implementation detail; the requirement is that the image bytes are inside the message the agent reads, not an external file reference.

### 6.4 Inform the agent

The agent must know an image is present:

- If content blocks are used, the presence of an `image` block is the signal.
- If a single text payload is used, include explicit text such as `[Image pasted into chat context]`.

### 6.5 Render in the transcript

The transcript component renders user messages:

- Text blocks render as today.
- Image blocks render as inline thumbnails using `data:{mimeType};base64,{data}`.
- If images are embedded as markdown data URIs in text, parse and render them as images.

### 6.6 Validation

| Limit | Value | Behavior |
|---|---|---|
| Max file size | 10 MB | Reject with inline error in Phase 1 |
| Max dimension | 4096 × 4096 | Reject with inline error in Phase 1 |
| Max images per message | 5 | Refuse additional pastes |
| Supported formats | PNG, JPEG, WebP, GIF | Accept and pass through MIME type |

Phase 2 may add downscaling instead of hard rejection.

### 6.7 Error Handling

| Scenario | Behavior |
|---|---|
| Image too large / wrong dimensions | Inline error in composer; do not stage |
| Too many images | Refuse additional paste; inline error |
| Runtime rejects image | Surface error in transcript |
| IPC timeout / exception | Inline error; keep previews staged |

## 7. Security and Privacy

- Images live in renderer memory as `ArrayBuffer` and are base64-encoded only for transport to the local agent runtime.
- No image bytes are written to disk as temporary files.
- No image bytes are logged to application logs or telemetry.
- Telemetry emits only `imageCount` and `totalSizeBytes`.
- Images sent to a provider runtime are subject to that provider’s terms.

## 8. Telemetry

Emit per successful send:

```ts
{
  event: 'image_paste_sent',
  imageCount: number,
  totalSizeBytes: number,
}
```

Emit per failure:

```ts
{
  event: 'image_paste_failed',
  errorCode: string,
}
```

## 9. Accessibility

- Preview strip has `aria-label` indicating pasted image count.
- Each remove button has `aria-label="Remove pasted image {index}"`.
- Each image preview has `alt="Pasted image"`.
- Focus returns to composer after removing previews.

## 10. Acceptance Criteria

1. Pasting an image into the composer shows a thumbnail preview.
2. Pasting text continues to work exactly as before.
3. Pressing Enter sends text + image as one chat message.
4. The image is delivered to the agent as part of the chat context, not as a file path.
5. The agent is informed that an image has been included.
6. The transcript renders the user message and the attached image(s).
7. Validation limits (10 MB, 4096×4096, 5 images) are enforced.
8. Telemetry events are emitted for success and failure.
9. Type-check and existing tests still pass.
10. New tests cover paste detection, preview state, and message send.

## 11. Phasing

**Phase 1 — Core image paste**
- Read image from clipboard, show preview, send with message.
- Deliver image to agent runtime as base64 content block or inline data URI.
- Render image in transcript.

**Phase 2 — Polish**
- Multi-image support up to 5.
- Instant-send setting.
- Downscale oversized images instead of rejecting.

**Phase 3 — Extended UX**
- Drag-and-drop file attachments.
- Persistent attachment history.

## 12. Open Questions

1. Does the current agent runtime accept structured content blocks with image data, or only a single text payload?
2. If only text is accepted, is a markdown data URI reliable enough for the agent to read the image?
3. Do we reject oversized images in Phase 1 or downscale them automatically?

## 13. Files to Touch

- Composer and paste handling (`src/renderer/components/Terminal/UnifiedTerminal.tsx` and tests)
- Image staging hook (`src/renderer/hooks/useTerminalImages.ts`)
- Transcript rendering (`src/renderer/components/AcpTranscript/UserTurn.tsx` and related)
- Telemetry (`src/renderer/lib/telemetry.ts`)
- Agent runtime prompt path (`src/main/acp/AcpRuntimeManager.ts` or equivalent)
- Shared types (`src/shared/acpTypes.ts` if extending prompt payloads)

---

*Ready for review. Once approved, split into implementation work orders for NextPert and QAPert.*
