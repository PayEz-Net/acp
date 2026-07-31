# ACP API → Desktop Repo Consolidation (Planned)

**Status:** VERIFIED — acp-api imported, paths rewired, standalone repo deprecated; QAPert build verification complete (8/10 flows clean; F4 email-OTP flow stands down and will not be deck-claimed end-to-end)
**Owner:** BAPert (lead / coordination), DotNetPert (implementation), Aurum (approval), QAPert (QA), NextPert (docs/tooling)
**Priority:** P0 — all hands; blocks Mac installer handoff and public OSS release line
**Written:** 2026-04-14 by Aurum
**Assigned by:** Operator 2026-07-30

---

## Implementation notes (2026-07-31)

- acp-api was imported from tag `pre-consolidation-v1` into `acp-desktop/acp-api/`.
- Dev spawn path in `src/main/api-server.ts` now resolves to the `acp-api/` subfolder.
- `scripts/prepare-acp-api.cjs` installs deps in `acp-api-release/` via `npm ci` (copying `node_modules` broke npm bin wrappers on macOS).
- Build config lives in `package.json` (`extraResources` from `acp-api-release`); `electron-builder.json` does not exist in this repo.
- Root `package.json` has `postinstall: "cd acp-api && npm install"` (Phase 4 Option A approved by Aurum).
- Standalone acp-api repo tagged `pre-consolidation-v1` and marked deprecated with a README.
- QAPert verification complete 2026-07-31: `npm run build:electron` clean; `npm run dist:mac` produces working artifacts (GH_TOKEN publish failure expected locally); dev path resolves to nested `acp-api/`; 8/10 end-to-end flows clean; F4 (email-OTP) stands down and will not be deck-claimed end-to-end.
- Remaining work: NextPert sweeps docs for stale references.

---

## Problem

`acp-api` (the Node.js backend) and `acp-desktop` (the Electron UI) are today two separate git repositories on two different Azure DevOps instances. They have no standalone use — neither one runs without the other. The separation is historical, not intentional.

Evidence the separation was meant to be temporary:
- `acp-desktop/electron-builder.json` already works around it with `extraResources: [{ from: "../acp-api", ... }]` — a build-time copy that assumes the sibling layout.
- `acp-desktop/src/main/*` spawns the backend via a path pointing at `E:\Repos\acp-api` in dev.
- `acp-desktop/CLAUDE.md` describes the backend living at `E:\Repos\acp-api` as if it's an external dependency, when it's really half of the same product.
- Every build currently reaches across the filesystem to slurp `acp-api` source via `../`.

## Target state

`acp-desktop` is the single repo. `acp-api` becomes a subfolder:

```
acp-desktop/
├── acp-api/                # Backend, previously a sibling repo
│   ├── agents/
│   ├── api/
│   ├── package.json        # own deps, installed via postinstall
│   └── ...
├── src/                    # Electron main + renderer (existing)
├── skills/
├── .agents/
├── electron-builder.json   # `extraResources` drops the `../` prefix
└── package.json
```

One git log. One origin remote. One public OSS release line on `PayEz-Net/acp`.

## Why P2 not P1

The current layout **works today**. Dev builds via `../acp-api`, packaged builds bundle the same via `extraResources`, runtime spawns the backend successfully. Nothing is broken. The consolidation is correctness and maintainability, not a production fire.

The VibeSQL Server Consolidation Spec (Day-1 through Day-8 in `E:\Repos\Agents\BAPert\specs\` — draft v0.1 in flight) is the current priority and will consume DotNetPert's calendar for the week. This consolidation waits until that lands.

## Current state snapshot (as of 2026-04-14)

**`acp-api` working tree is dirty** — do NOT bulk-copy as-is. Multiple sessions' worth of in-flight work that needs to be reviewed, split into clean commits, and landed on its own origin before consolidation:

```
M  agents/session_manager.js       (Phase-1 project registry stub — mirrors vibe.documents seed)
M  api/contractors/service.ts
M  api/lifecycle/configValidator.ts
M  api/middleware/localAuth.ts
M  api/routes/agents.ts
M  api/routes/chat.ts
M  api/routes/documents.ts
M  api/routes/mailProxy.ts
M  api/routes/projects.ts
M  api/server.js
M  chat/persistence.ts
M  config.ts
D  storage/adapter.js
D  storage/vibesql_client.js
?? api/auth/
?? api/routes/auth.ts
?? api/routes/cliProxy.js
```

Any consolidation PR that snapshots this dirty state into `acp-desktop` would commit half-baked work into the canonical public OSS repo. Not acceptable.

## Plan (when scheduled)

### Phase 1 — Stabilize `acp-api` on its own origin

1. **Review the 19 pending changes** with the author (Jon / DotNetPert session that made them). Separate concerns:
   - Auth middleware/routes (new `api/auth/` folder + `api/middleware/localAuth.ts` + `api/routes/auth.ts`) — likely one commit
   - `storage/` removal (`adapter.js` + `vibesql_client.js`) — deprecation commit
   - `session_manager.js` project stub — already tied to today's ACP unblock, standalone commit with pointer to DB seed doc 8028
   - Route changes (`chat.ts`, `documents.ts`, `mailProxy.ts`, `projects.ts`, `agents.ts`) — probably tied to project/mail work, one or two commits
   - Misc (`config.ts`, `server.js`, `contractors/service.ts`, `lifecycle/configValidator.ts`, `chat/persistence.ts`, `cliProxy.js`) — case by case
2. **Land all commits on `acp-api`'s `origin`** (Azure DevOps `Agent Collaboration Platform`).
3. **Tag a release point** (`pre-consolidation-v1`) so the consolidation PR can reference the exact input state.

### Phase 2 — Copy into `acp-desktop`

1. `git clone` `acp-api` at the tagged commit into a scratch location.
2. Strip: `.git/`, `node_modules/`, `dist/`, `release/`, `build/`, any log files or local-only artifacts.
3. Copy the clean tree to `acp-desktop/acp-api/`.
4. `git add acp-api/` in acp-desktop, commit with message referencing the acp-api tag: `consolidate: import acp-api@pre-consolidation-v1 as acp-api/ subfolder`.

### Phase 3 — Rewire paths

1. **`acp-desktop/electron-builder.json`** — change `extraResources` path from `"../acp-api"` to `"acp-api"`. Filter stays the same.
2. **`acp-desktop/src/main/*.ts`** — find where the backend process is spawned. Any hardcoded `E:\Repos\acp-api` path becomes relative to the app root:
   - **Dev**: `path.join(__dirname, '..', '..', 'acp-api', 'api', 'server.js')` (or whatever resolves from the main bundle)
   - **Packaged**: `path.join(process.resourcesPath, 'acp-api', 'api', 'server.js')`
3. **`acp-desktop/CLAUDE.md`** — update "Backend API" row from `E:\Repos\acp-api` to `acp-desktop/acp-api/`. Update "External Services" row the same way.
4. **`acp-desktop/package.json`** — add a `postinstall` script: `cd acp-api && npm install`, so `npm install` at root also installs the backend's deps. OR add `acp-api` to a `workspaces` field (decision in Phase 4).

### Phase 4 — npm structure decision

Two options, pick before shipping:

**Option A (nested package, simpler):**
- `acp-api/package.json` stays, has its own `node_modules/` after install
- Root `package.json` adds `postinstall: "cd acp-api && npm install"`
- `electron-builder.json` already treats acp-api's deps as bundled resources (it filters `node_modules/**/*` from `../acp-api` today, same filter would apply to `acp-api`)
- **Recommended** — minimal disruption to existing build tooling

**Option B (true monorepo with npm workspaces):**
- Root `package.json` adds `workspaces: ["acp-api"]`
- All deps hoisted to root `node_modules/` where possible
- Shared deps deduplicate automatically
- More invasive — changes install semantics for existing contributors, may break `electron-builder.json` resource filtering

Default to A unless a specific need drives B.

### Phase 5 — Archive the standalone repo

1. Add a deprecation notice README to the standalone `acp-api` repo pointing at the new location.
2. Keep the old repo as a read-only mirror for a transitional period (4–8 weeks).
3. Update any external references (CI/CD, sync scripts, docs, bookmarks) to point at the new location.
4. Archive the Azure DevOps `Agent Collaboration Platform` repo after the transitional period.

## Risks

- **In-flight work snapshotting.** Mitigated by Phase 1 — nothing copies until `acp-api` is stable on its own.
- **Main-process spawn path bugs.** The dev vs packaged-app path split is fragile; test both `npm run dev:electron` and a real `npm run dist` build after rewiring Phase 3 step 2.
- **CI / deploy pipelines.** If Azure DevOps has a build pipeline for `Agent Collaboration Platform` repo, it needs to be retired or redirected. Audit before archival.
- **`agent-mail-cli` duplication.** Both repos have an `agent-mail-cli/` folder today. After consolidation the `acp-desktop/agent-mail-cli/` is the canonical one; `acp-api` probably doesn't need its own copy. Check references during Phase 3.
- **Contributors with open PRs against `acp-api` origin.** Any in-flight PR needs to be retargeted or replayed against `acp-desktop/acp-api/` after consolidation.

## Non-goals

- Rewriting any backend code during consolidation. This is a pure layout move, no refactoring.
- Changing the HTTP API surface the Electron shell consumes. The backend runs exactly as-is, just from a different filesystem location.
- Converting `acp-api` from plain JS ESM to TypeScript. That's a separate migration already in progress.

## When to schedule

- **Not during VibeSQL Server Consolidation Spec** (`2026-04-14` through `2026-04-22` target). DotNetPert is committed to that project.
- **After VibeSQL spec ships.** Pick a low-traffic day. Estimated 4–8 hours of focused work including the cleanup commit split in Phase 1.
- **Tag the work** in BAPert's backlog / kanban as "ACP-API Consolidation" P2.
