# Research: Replace Custom Composer Image Handling with Kimi Native Pipeline

**From:** Jon
**To:** BAPert
**Date:** 2026-07-20
**Re:** Work order input — image paste in acp-desktop
**Requested outcome:** BAPert authors a WO from this brief (decision locked with Jon first, see §5)

---

## 1. Why now

Image paste in the acp-desktop composer is broken again (2026-07-20: Ctrl+V stages
nothing — renderer-side, all 80 paste unit tests still green). Rather than patch
our custom pipeline a third time, Jon's direction: **the new kimi CLI has native
image paste — research replacing our custom chat input image handling with kimi's
own and solve it properly.** This doc is the research; the WO defines the work.

Repo facts below verified against `E:/repos/kimi-code` @ `b5d31ffc3`
(apps/kimi-code 0.27.0, branch `feat/runtime-wait-state-visibility`) and
`E:/repos/acp-desktop` working copy.

## 2. What kimi ships natively (TUI)

Native clipboard image paste exists **since 0.20.0** — not new in 0.27.0, but
hardened through 0.23.5:

- Trigger: **Ctrl+V (Linux/macOS), Alt+V (Windows)** — Windows terminals reserve
  Ctrl+V. `apps/kimi-code/src/tui/components/editor/custom-editor.ts:387-417`;
  wired via `tui/controllers/editor-keyboard.ts:357` → `handleClipboardImagePaste()`
  (`editor-keyboard.ts:426-503`).
- Clipboard read with per-OS fallback chain (osascript / native / wl-paste / xclip /
  WSL PowerShell), also accepts copied image *files* and video:
  `apps/kimi-code/src/utils/clipboard/clipboard-image.ts:401-457`.
- After paste: **compressed immediately** (`compressImageForModel`,
  `packages/agent-core/src/tools/support/image-compress.ts:261-369`), original
  persisted content-addressed into `<sessionDir>/media-originals/`, staged as an
  attachment, and a text placeholder inserted at cursor: `[image #1 (1920×1080)]`
  (`tui/utils/image-attachment-store.ts:62-138`).
- On submit, placeholders expand to `image_url` data-URL prompt parts with a
  compression caption (`tui/utils/image-placeholder.ts:51-102`). Transcript renders
  inline thumbnails via Kitty/iTerm2 graphics where supported
  (`tui/components/media/image-thumbnail.ts`).
- UX touches we lack: footer hint "Image in clipboard · Ctrl+V to paste"
  (`tui/controllers/clipboard-image-hint.ts`), and submit-time refusal when the
  model can't see images (`kimi-tui.ts:1143-1164`).

## 3. The server-side pipeline (what an ACP client gets for free)

This is the part that matters for acp-desktop: **our ACP `session/prompt` image
blocks already flow through kimi's full native pipeline.** Verified:

- Adapter advertises `promptCapabilities: { image: true, embeddedContext: true }`
  (`packages/acp-adapter/src/server.ts:226-230`).
- `{type:'image', data, mimeType}` blocks → `image_url` data-URL parts verbatim
  (`packages/acp-adapter/src/convert.ts:34-37`), then `compressPromptImageParts`
  (`convert.ts:102-163`) runs per prompt:
  - **Format gate first** (`gateImageFormatParts`): closed accepted set
    **PNG/JPEG/GIF/WebP** (`image-format-policy.ts:34-39`); magic bytes override
    declared MIME; unsupported (AVIF/HEIC/BMP/TIFF/ICO) → replaced by a text
    notice, never poisons session history (#1536, shipped 0.23.5).
  - **Compression**: longest-edge cap **2000px** default (configurable via
    `[image] maxEdgePx` / `KIMI_IMAGE_MAX_EDGE_PX`; was 3000 briefly in 0.23.2,
    reverted 0.23.4); byte budget **3.75 MB** raw per prompt image
    (`image-compress.ts:58,102`). Lossless-first ladder; GIF/animated WebP pass
    through to preserve animation; EXIF orientation applied.
  - **Never silent**: compressed images get a caption + original persisted for
    `ReadMediaFile` `region` readback at full fidelity (`image-compress.ts:884-900`,
    `read-media.ts:114-126`).
- **No client-side count limit** anywhere; provider "too many images" 400s
  surface as errors (not auto-recovered).
- Turn-level backstop re-gates everything (`agent-core/src/agent/turn/index.ts:150-168`).

## 4. Gap analysis — desktop custom pipeline vs kimi native

Our custom path today: React staging hook (`useTerminalImages.ts`) → base64 → IPC →
`AcpRuntimeManager.sendMessage` → ACP image blocks. Duplicated correctness logic
we'd get to **delete**: format whitelist, 10 MB size check, 4096px dimension check,
dimension sniffing. The server does all of this better (byte-sniffing, EXIF,
per-model budgets).

What the desktop must still own even after delegating:

1. **Encode to an accepted format before send.** kimi gates, doesn't convert, at
   ingestion. Electron `NativeImage.toPNG()`/canvas re-encode covers BMP/etc.
2. **Optional pre-downscale for transport cost only** (≤2000px): avoids base64'ing
   20 MB screenshots over IPC+stdio; not needed for correctness.
3. **Model-capability UX — the one real gap.** `image_in` is **not surfaced over
   ACP** (`acp-adapter/src/model-catalog.ts:43-57` exposes thinking fields only),
   and the adapter doesn't refuse image prompts for non-vision models — the image
   is silently replaced with `[image omitted: current model has no image input]`
   at `agent-core/src/agent/turn/kosong-llm.ts:300-345`. With model overrides live
   (WO-KIMI-MODEL-OVERRIDE: k3 / kimi-for-coding / -highspeed, capability is
   server-catalog-driven per model), a client-side gate or tolerance decision is
   required. Candidate fix: fork delta to expose `image_in` in the ACP model
   catalog — small, aligns with our wait-state fork work.
4. **Video has no ACP path** (TUI-only: clipboard video, VideoUploader). Out of
   scope unless Jon wants it.
5. **Keep our staging UI** (chips, removal, count) and our own copies of sent
   images for transcript history — `session/load` re-emits text only
   (`acp-adapter/src/session.ts:501`).

## 5. Options for the WO (Jon to lock)

**Option A — Delegate correctness, keep our composer (recommended).**
Strip `useTerminalImages`/`UnifiedTerminal` down to: stage → encode accepted
format → optional ≤2000px pre-scale → ACP image blocks. Delete local format/size/
dimension validation in favor of server gate semantics (surface server text
notices in the transcript). Add client-side `image_in` handling per §4.3.
Small, reviewable, keeps the ACP transcript redesign intact. Also fixes the
current "nothing stages" class of bugs by shrinking the renderer surface we own.

**Option B — Replace the composer with kimi's TUI input wholesale.**
The kimi input is a **terminal editor** (pi-tui), not an embeddable web component
— "using kimi's input" literally means PTY-mode terminals and abandoning the ACP
structured transcript (permissions, wait-state, queue visibility, replay). High
blast radius, throws away the last two months of ACP work. Documented here for
completeness; not recommended.

## 6. Suggested WO acceptance criteria (Option A)

- Paste image → chip stages → Enter → agent receives image end-to-end over ACP
  (kimi default model AND each model-override alias).
- Server-side behaviors verified from the desktop: >2000px image arrives with
  compression caption; unsupported format arrives as text notice (no session
  poisoning); multi-image prompt (3×) delivers all parts.
- `image_in`-absent model: defined UX (refuse with message OR visible downgrade
  notice) — no silent swallow.
- Deleted: local 10 MB/4096px/format-whitelist/dimension-sniffing code paths and
  their tests, replaced by server-gate coverage.
- Version floor pinned: spawned kimi/acp-adapter ≥ 0.23.5 (format gate) — assert
  at spawn, fail loud otherwise.

## 7. References

- kimi TUI paste: `kimi-code/apps/kimi-code/src/tui/controllers/editor-keyboard.ts:426`,
  `.../components/editor/custom-editor.ts:387-417`
- ACP conversion/gating: `kimi-code/packages/acp-adapter/src/convert.ts:25-163`,
  `.../src/server.ts:226-230`
- Format policy/compression: `kimi-code/packages/agent-core/src/tools/support/image-format-policy.ts:34-66`,
  `image-compress.ts:58,102,261-369`
- Desktop code to slim: `acp-desktop/src/renderer/hooks/useTerminalImages.ts`,
  `acp-desktop/src/renderer/components/Terminal/UnifiedTerminal.tsx:864-938,1279-1291`,
  `acp-desktop/src/main/acp/AcpRuntimeManager.ts:539-550,780-793`
- Prior art docs: `docs/IMAGE_PASTE_TERMINAL_INPUT_PRD.md`,
  `docs/WO-IMAGE-PASTE-CHAT-CONTEXT-QA-20260709-PLAN.md`,
  `docs/WO-KIMI-MODEL-OVERRIDE.md`
