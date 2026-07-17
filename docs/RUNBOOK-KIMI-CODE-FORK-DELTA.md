# RUNBOOK: kimi-code Fork Delta — Re-apply on Every Upstream Release

**Owner:** NextPert (execution), BAPert (document)
**Audience:** anyone re-applying our local patch to a new kimi-code upstream release
**Last verified:** 2026-07-17 against upstream main @ 7d393b56f (CLI 0.27.0)
**Retires when:** the upstream PR merges (submission: Jon + BAPert)

---

## What the delta is

One branch in `E:/repos/kimi-code`: **`feat/runtime-wait-state-visibility`**, one commit `b5d31ffc3` — "feat(acp): report provider wait states and bound provider request hangs" (14 files, +430/-4).

It does two things (WO-RUNTIME-WAIT-STATE-VISIBILITY, Phase A):
1. Surfaces provider wait states over ACP as a `wait_state` sessionUpdate variant (kinds: `awaiting_first_token`, `provider_retry`).
2. Bounds provider request hangs: `timeout: 120_000` + `maxRetries: 0` on all four kosong SDK providers (pre-headers only — verified it cannot abort healthy long streams).

**Re-appliable patch** (if the branch is ever lost): `acp-desktop/docs/patches/WO-RUNTIME-WAIT-STATE-VISIBILITY-phaseA-kimi-code.patch` — `git apply` onto `origin/main`.

## The re-apply procedure (per upstream release)

### 1. Sync and re-apply

```bash
cd /e/repos/kimi-code
git fetch origin
git status                      # expect clean-ish; our work lives on the delta branch
git checkout main && git reset --hard origin/main
git checkout feat/runtime-wait-state-visibility
git rebase main                 # resolve conflicts if upstream touched the same files
# Alternative if the branch is lost: git checkout -b feat/runtime-wait-state-visibility
#   && git apply /e/repos/acp-desktop/docs/patches/WO-RUNTIME-WAIT-STATE-VISIBILITY-phaseA-kimi-code.patch
```

### 2. Toolchain (workspace-local, no system changes)

- Portable Node 24.15.0 lives at `E:/repos/.tmp/node24/node` (re-download the zip from nodejs.org if `.tmp` was cleaned).
- Prefix PATH with the **POSIX-style** path and drive pnpm through that node's corepack:

```bash
export PATH="/e/repos/.tmp/node24/node:$PATH"   # POSIX form REQUIRED — Windows-style is silently ignored by Git Bash
corepack pnpm --version                          # must resolve the repo-pinned pnpm (10.33.0)
```

- **Never** system node (v20 — repo is engine-strict ≥24.15), **never** system pnpm (10.5.2), **never** bare `pnpm` (no shim in the portable dir — always `corepack pnpm ...`).

### 3. Build

```bash
cd /e/repos/kimi-code
corepack pnpm install                            # ~3 min
cd apps/kimi-code && corepack pnpm build         # REQUIRED before SEA (produces dist/ + dist-web/)
corepack pnpm build:native:sea                   # -> apps/kimi-code/dist-native/bin/win32-x64/kimi.exe
```

### 4. Verify (expected counts as of 0.27.0+delta)

```bash
cd packages/acp-adapter && corepack pnpm typecheck && corepack pnpm test      # 308/308
cd ../kosong && corepack pnpm typecheck && corepack pnpm exec vitest run      # 1274/1274
cd ../agent-core && corepack pnpm exec vitest run test/loop/ test/agent/turn.test.ts  # 229/229
corepack pnpm exec oxlint --type-aware <changed files>                        # 0 errors
cd ../../apps/kimi-code && corepack pnpm test:native:smoke                    # PASS (from packages/agent-core; or return to repo root first)
```

### 5. Install (rename-swap — works while the exe is locked; NEVER kill live agent runtimes)

```bash
mv ~/.kimi-code/bin/kimi.exe ~/.kimi-code/bin/kimi-<old-version>.bak.exe
cp /e/repos/kimi-code/apps/kimi-code/dist-native/bin/win32-x64/kimi.exe ~/.kimi-code/bin/kimi.exe
~/.kimi-code/bin/kimi.exe --version              # expect the new version
```

Live agents keep the old image in memory and pick up the new binary on their next natural restart. If anything ever requires killing live processes to install, **stop — Jon owns that call.**

### 6. Acceptance probe (the finish line)

```bash
node /e/repos/acp-desktop/docs/tools/acp-probe.mjs
# PASS: turn completes end_turn AND >=1 wait_state frame.
# Exit codes: 0 = patched binary confirmed live · 2 = turn never completed within
# 180s (runtime wedged) · 3 = zero wait_state frames (installed runtime predates
# the patch — doubles as the installed-version check)
```

## Gotchas (all bit us on 2026-07-17)

- `corepack prepare` on the **system** node fails pnpm 10.33 signature verification ("Cannot find matching keyid") — use the portable node's own corepack.
- `build:native:sea` alone fails asserting dist-web missing — run the full `pnpm build` first.
- signtool absent on this box → "signtool ENOENT" / "signature seems corrupted" warnings during SEA inject — harmless for local install (ad-hoc signing skipped).
- GitNexus CLI `analyze` segfaults on this machine (acp-desktop AGENTS.md asks for it) — manual impact analysis is the accepted workaround.
- `pnpm install` skips some build scripts (esbuild, node-pty) with default policy — fine for typecheck/tests/SEA; node-pty only matters for terminal tooling.

## History

| Date | Upstream | Delta | Installed | Verified |
|---|---|---|---|---|
| 2026-07-17 | 7d393b56f (0.27.0) | b5d31ffc3 | 0.27.0+patch (rename-swap, 0.24.2 backed up) | suites + native smoke + live probe (2 wait_state frames) |
