# Merge Instructions: Terminal Footer Status Dashboard

## Status

- **Work order / branch:** `wo/92267-terminal-min-dimensions`
- **Target branch:** `main`
- **QA verdict:** GO (QAPert)
- **BA clearance:** Clear to merge (BAPert)
- **Test result:** 152 passing, `npx tsc --noEmit` clean, `npx vite build` green

## What This Change Does

Implements a per-agent terminal footer status dashboard and tightens stream hygiene for provider TUI junk inside terminal panes.

- Parses provider footer metadata (`context: 38.5%`, token ratios, `yolo agent (...)` banners, `Composing...` state) from the PTY stream.
- Stores parsed status in `agentStatusStore` keyed by agent name.
- Surfaces the data in a compact footer inside each `TerminalPane` via `TerminalFooter` / `UnifiedTerminal`.
- Aggressively drops provider TUI redraws (`yolo agent`, `— input`, keybinding hints, spinner frames, separator lines) before they reach the pane surface.

## Files That Belong to This Change

### Modified

- `AGENTS.md`
- `src/renderer/components/Logs/LogViewer.tsx`
- `src/renderer/components/Mail/MailSidebar.tsx`
- `src/renderer/components/Terminal/TerminalGrid.tsx`
- `src/renderer/components/Terminal/TerminalPane.test.tsx`
- `src/renderer/components/Terminal/TerminalPane.tsx`
- `src/renderer/components/Terminal/UnifiedTerminal.test.tsx`
- `src/renderer/components/Terminal/UnifiedTerminal.tsx`
- `src/renderer/hooks/useMail.ts`
- `src/renderer/index.html`
- `src/renderer/lib/terminalStream.test.ts`
- `src/renderer/lib/terminalStream.ts`
- `src/renderer/stores/appStore.ts`
- `src/renderer/stores/mailStore.ts`
- `src/renderer/stores/projectStore.ts`
- `src/renderer/styles/globals.css`
- `tailwind.config.js`
- `terminalpane_clean.tsx` (deleted)

### Added

- `.claude/skills/acp-output-frame/`
- `.kimi/skills/acp-output-frame/`
- `docs/ACP_DESIGN_SYSTEM_V1.md`
- `docs/ACP_OUTPUT_FRAME.md`
- `docs/ACP_TERMINAL_FOOTER_STATUS_PLAN.md`
- `docs/ACP_TERMINAL_FRAME_LAYOUT.md`
- `src/renderer/components/Layout/BottomBar.tsx`
- `src/renderer/components/Terminal/TerminalFooter.test.tsx`
- `src/renderer/components/Terminal/TerminalFooter.tsx`
- `src/renderer/stores/agentStatusStore.test.ts`
- `src/renderer/stores/agentStatusStore.ts`

## Files to Leave Out of This Merge (Pre-existing Unrelated Work)

These are present in the working tree but are not part of the terminal footer / stream-hygiene work. They should be stashed before the merge and restored afterward.

### Modified

- `.env.example`
- `src/main/auth.ts`
- `src/main/index.ts`
- `src/main/preload.ts`

### Added / Untracked

- `src/main/loadEnv.ts`
- `src/main/ptyOutputReporter.test.ts`
- `src/main/ptyOutputReporter.ts`
- `src/main/vsql-cache-client.test.ts`
- `src/main/vsql-cache-client.ts`
- `src/renderer/hooks/useVsqlCacheSse.ts`
- `src/renderer/stores/mailStore.test.ts`
- `docs/TERMINAL_PROVIDER_UNIFICATION_PRD.md`
- `docs/TERMINAL_PROVIDER_UNIFICATION_TESTPLAN.md`
- `docs/vsql-cache-wiring-report.md`
- `acp-restart-monitor.ps1`
- `.tmp/`

## Merge Steps

Run from repo root (`E:\repos\acp-desktop` or equivalent).

```powershell
# 1. Make sure you're on the feature branch
git branch --show-current
# Expected: wo/92267-terminal-min-dimensions

# 2. Stage and commit only the terminal/footer files listed above.
#    (Adjust the list if anything was missed.)
git add AGENTS.md
git add src/renderer/components/Logs/LogViewer.tsx
git add src/renderer/components/Mail/MailSidebar.tsx
git add src/renderer/components/Terminal/TerminalGrid.tsx
git add src/renderer/components/Terminal/TerminalPane.test.tsx
git add src/renderer/components/Terminal/TerminalPane.tsx
git add src/renderer/components/Terminal/UnifiedTerminal.test.tsx
git add src/renderer/components/Terminal/UnifiedTerminal.tsx
git add src/renderer/hooks/useMail.ts
git add src/renderer/index.html
git add src/renderer/lib/terminalStream.test.ts
git add src/renderer/lib/terminalStream.ts
git add src/renderer/stores/appStore.ts
git add src/renderer/stores/mailStore.ts
git add src/renderer/stores/projectStore.ts
git add src/renderer/styles/globals.css
git add tailwind.config.js

git add .claude/skills/acp-output-frame/
git add .kimi/skills/acp-output-frame/
git add docs/ACP_DESIGN_SYSTEM_V1.md
git add docs/ACP_OUTPUT_FRAME.md
git add docs/ACP_TERMINAL_FOOTER_STATUS_PLAN.md
git add docs/ACP_TERMINAL_FRAME_LAYOUT.md
git add src/renderer/components/Layout/BottomBar.tsx
git add src/renderer/components/Terminal/TerminalFooter.test.tsx
git add src/renderer/components/Terminal/TerminalFooter.tsx
git add src/renderer/stores/agentStatusStore.test.ts
git add src/renderer/stores/agentStatusStore.ts

git rm terminalpane_clean.tsx

git commit -m "feat(terminal): per-agent status footer and stream-hygiene cleanup

- Parse provider footer metadata (context %, tokens, cwd, model, composing) into agentStatusStore.
- Surface parsed status in TerminalFooter inside each pane.
- Aggressively drop yolo agent banners, — input prompts, keybinding hints, spinner frames, and separator lines.
- Add ACP Output Frame spec and skills.
- QAPert GO: 152 tests passing."

# 3. Stash unrelated changes (including untracked files) so they don't ride along.
git stash push --include-untracked -m "unrelated pre-existing changes before terminal footer merge"

# 4. Switch to main and merge the feature branch.
git checkout main
git merge wo/92267-terminal-min-dimensions

# 5. Restore unrelated work to the new main working tree.
git stash pop

# 6. Verify.
npm run test -- --run
npx tsc --noEmit
npx vite build
```

## If Stash Pop Conflicts

If `git stash pop` conflicts with `main` or the merged changes:
- Do **not** auto-resolve.
- Stop and ask the operator which side to keep.
- Alternatively, leave the stash in place and let the operator reapply manually later.

## Post-merge Reporting

Once the merge is complete and verification passes, reply to BAPert's mail (id 10782 / thread `4190205e72e243f4`) with:

> Merged `wo/92267-terminal-min-dimensions` into `main`. Verification: 152 tests passing, tsc clean, vite build green.
