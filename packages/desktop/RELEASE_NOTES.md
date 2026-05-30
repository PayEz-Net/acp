# ACP — Release Branch (`release`)

This is the branch ACP builds / installers are cut from. Until now builds came
off whatever feature branch happened to be active; this branch gives them one
stable home.

## Cutting a build

```bash
git checkout release
npm install
npx electron-rebuild        # rebuild node-pty against Electron's ABI (required on a fresh machine)
npm run dev:electron        # dev run (auto-spawns the sibling ../acp-api)
npm run dist:win            # packaged Windows installer (NSIS + portable)
npm run dist:mac            # packaged macOS dmg/zip
```

(macOS first-time setup has an extra native-rebuild step — see the ACP desktop
Mac setup guide.)

## In this cut

- **ACP toolbar is read-only** (#47 / commit `21c6ecd`). Team/agent/project
  editing lives on idealvibe.online; ACP observes and runs the agents.
  - **Chat button removed** from the top nav — it was untested, never shipped in
    a release, and **crashed ACP when clicked**. This is the headline fix.
  - **Edit Team** and **Project Settings** buttons removed from the top nav.
  - Reversible: re-enable instructions are left as comments in `TitleBar.tsx`;
    the underlying panels stay wired in `App.tsx`.

**Verify on the next build:** no Chat button in the ACP top nav (and no crash),
and no Edit Team / Project Settings buttons in the toolbar.

## Known debt (flagged to BAPert — recorded here, not decided on this branch)

1. **~413 MB of build artifacts are committed in git history**
   (`release-smoke/win-unpacked/`, the `*.exe` installers) via commit
   `1db36c1 "Apply agent edits"`. They bloat every clone. Fix: untrack +
   `.gitignore` them, then scrub from history (`git filter-repo`).
2. **Never track build output.** `release-smoke/`, `release/`, `win-unpacked/`,
   `*.exe`, and `acp-api-release/` are build artifacts — gitignore them.
3. **Terminal-viewport fixes vs. reverts diverge** between this branch and
   `master` (`master` reverted two terminal fixes this lineage still carries).
   Reconcile which terminal state is canonical before cutting a clean release base.
4. This branch sits on the `feat/acp-toolbar-readonly-47` lineage. Once items 1
   and 3 are resolved, re-cut a clean `release` base.

## Convention going forward

- Cut builds from `release`.
- Land reviewed fixes here (merge or cherry-pick from feature branches); keep
  build artifacts out of git.
- Tag each shipped build.
