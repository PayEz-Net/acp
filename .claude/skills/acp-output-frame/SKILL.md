---
name: acp-output-frame
description: "Use for every response in the acp-desktop repo. Enforces the ACP Output Frame formatting spec."
---

# ACP Output Frame

All responses in this workspace must follow `docs/ACP_OUTPUT_FRAME.md`.

## Quick Rules

- **Verdict first.** One-line answer at the top.
- **Use `## Changes`, `## Verification`, `## Next / Open`.**
- **Status words:** `PASS`, `FAIL`, `WARN`, `SKIP`, `BLOCKED`.
- **File refs:** repo-root relative, e.g. `src/renderer/App.tsx`.
- **No emoji, no hedging, no sign-offs.**

## Read the Full Spec

`docs/ACP_OUTPUT_FRAME.md`

If the user request conflicts with the frame, the user request wins — note the override explicitly.
