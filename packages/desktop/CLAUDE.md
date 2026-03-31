# ACP — Agent Collaboration Platform (Desktop Shell)

This is the **desktop UI** of ACP. The backend API lives at `E:\Repos\acp`.

ACP is one product with two halves:

| Layer | Repo | Tech |
|-------|------|------|
| **Desktop Shell** | `E:\Repos\acp-desktop` (this repo) | Electron 28 + React 18 + TypeScript + Vite |
| **Backend API** | `E:\Repos\acp` | Node.js + Express (migrating to TypeScript) |

## What This Repo Contains

The Electron desktop app that humans use to orchestrate, observe, and interact with the AI agent team.

## Tech Stack

- **Electron 28** — Desktop framework
- **React 18** + **TypeScript** — UI
- **Vite** — Build tool
- **xterm.js** + **node-pty** — Terminal emulation (each pane runs a Claude Code session)
- **zustand** — State management
- **electron-store** — Settings persistence
- **Tailwind CSS** — Styling
- **@microsoft/signalr** — Real-time communication
- **react-markdown** + rehype/remark — Markdown rendering in UI

## Architecture

```
acp-desktop/
├── src/
│   ├── main/              Electron main process
│   │   ├── index.ts       App entry, window management
│   │   ├── pty.ts         PTY spawning, auto-injects "report as AgentName"
│   │   ├── store.ts       Settings persistence (electron-store)
│   │   ├── preload.ts     Context bridge for renderer
│   │   ├── auth.ts        Authentication
│   │   ├── idp-client.ts  IDP integration
│   │   └── oauth-server.ts Local OAuth server
│   ├── renderer/          Electron renderer process (React)
│   │   ├── App.tsx        Root component
│   │   ├── components/    UI components
│   │   │   ├── Terminal/  xterm.js terminal grid
│   │   │   └── Layout/    TitleBar, sidebars
│   │   ├── hooks/         React hooks
│   │   ├── services/      API clients
│   │   ├── stores/        Zustand state (appStore.ts)
│   │   ├── styles/        Tailwind + CSS
│   │   └── lib/           Utilities
│   └── shared/            Shared between main + renderer
│       ├── types.ts       TypeScript interfaces, IPC channels
│       └── auth.ts        Auth types
├── agent-mail-cli/        Bundled agent mail CLI
└── electron-builder.json  Build configuration
```

## Development

```bash
npm install

# Dev mode (Vite + Electron with hot reload)
npm run dev:electron

# Build for production
npm run dist:win    # Windows (NSIS installer)
npm run dist:mac    # macOS (DMG)
npm run dist:linux  # Linux (AppImage)
```

Dev server runs on port 40010. Use `npm run kill-port` if the port is stuck.

## IPC Channels

| Channel | Direction | Purpose |
|---------|-----------|---------|
| `pty:spawn` | Renderer → Main | Spawn PTY for agent |
| `pty:write` | Renderer → Main | Send input to PTY |
| `pty:data` | Main → Renderer | PTY output |
| `settings:get/set` | Both | Settings sync |

## Agent Configuration

Default 4-pane grid (configurable in settings):

| Position | Agent | Role |
|----------|-------|------|
| Top-left | NextPert | Frontend (Next.js) |
| Top-right | BAPert | Coordinator / BA |
| Bottom-left | DotNetPert | Backend (.NET) |
| Bottom-right | QAPert | QA / Testing |

Each pane spawns a Claude Code session via node-pty and auto-injects `"report as {AgentName}"`.

## Feature Roadmap

### Phase 1 (MVP) — Done
- [x] Electron + React + Vite scaffold
- [x] 4-pane terminal grid with xterm.js
- [x] Agent auto-injection ("report as X")
- [x] Grid/Focus layouts
- [x] Settings persistence

### Phase 2 — In Progress
- [ ] Mail sidebar (Agent Mail integration)
- [ ] Chat panel (real-time agent chat — spec: ACP-agent-chat-architecture-v1.1)
- [ ] Unread badges

### Phase 3
- [ ] Kanban sidebar with drag-and-drop
- [ ] Task assignment UI

## External Services

- **ACP Backend API**: `../api` (port 3001)
- **Agent Mail**: `https://api.idealvibe.online` (enterprise auth)
- **VibeSQL**: `http://localhost:5173` (or set `VIBESQL_URL`)
- **Agent Mail CLI**: bundled at `agent-mail-cli/`

## Key Specs

- **Chat Architecture**: `E:\Repos\Agents\BAPert\specs\ACP-agent-chat-architecture-v1.md`
- **Harness Spec**: `E:\Repos\Agents\BAPert\specs\planned\VIBE_AGENTS_HARNESS_SPEC.md`
- **Harness Analysis**: `E:\Repos\acp\docs\acp_harness_analysis.md`

<!-- gitnexus:start -->
# GitNexus — Code Intelligence

This project is indexed by GitNexus as **acp-desktop** (625 symbols, 1257 relationships, 37 execution flows). Use the GitNexus MCP tools to understand code, assess impact, and navigate safely.

> If any GitNexus tool warns the index is stale, run `npx gitnexus analyze` in terminal first.

## Always Do

- **MUST run impact analysis before editing any symbol.** Before modifying a function, class, or method, run `gitnexus_impact({target: "symbolName", direction: "upstream"})` and report the blast radius (direct callers, affected processes, risk level) to the user.
- **MUST run `gitnexus_detect_changes()` before committing** to verify your changes only affect expected symbols and execution flows.
- **MUST warn the user** if impact analysis returns HIGH or CRITICAL risk before proceeding with edits.
- When exploring unfamiliar code, use `gitnexus_query({query: "concept"})` to find execution flows instead of grepping. It returns process-grouped results ranked by relevance.
- When you need full context on a specific symbol — callers, callees, which execution flows it participates in — use `gitnexus_context({name: "symbolName"})`.

## When Debugging

1. `gitnexus_query({query: "<error or symptom>"})` — find execution flows related to the issue
2. `gitnexus_context({name: "<suspect function>"})` — see all callers, callees, and process participation
3. `READ gitnexus://repo/acp-desktop/process/{processName}` — trace the full execution flow step by step
4. For regressions: `gitnexus_detect_changes({scope: "compare", base_ref: "main"})` — see what your branch changed

## When Refactoring

- **Renaming**: MUST use `gitnexus_rename({symbol_name: "old", new_name: "new", dry_run: true})` first. Review the preview — graph edits are safe, text_search edits need manual review. Then run with `dry_run: false`.
- **Extracting/Splitting**: MUST run `gitnexus_context({name: "target"})` to see all incoming/outgoing refs, then `gitnexus_impact({target: "target", direction: "upstream"})` to find all external callers before moving code.
- After any refactor: run `gitnexus_detect_changes({scope: "all"})` to verify only expected files changed.

## Never Do

- NEVER edit a function, class, or method without first running `gitnexus_impact` on it.
- NEVER ignore HIGH or CRITICAL risk warnings from impact analysis.
- NEVER rename symbols with find-and-replace — use `gitnexus_rename` which understands the call graph.
- NEVER commit changes without running `gitnexus_detect_changes()` to check affected scope.

## Tools Quick Reference

| Tool | When to use | Command |
|------|-------------|---------|
| `query` | Find code by concept | `gitnexus_query({query: "auth validation"})` |
| `context` | 360-degree view of one symbol | `gitnexus_context({name: "validateUser"})` |
| `impact` | Blast radius before editing | `gitnexus_impact({target: "X", direction: "upstream"})` |
| `detect_changes` | Pre-commit scope check | `gitnexus_detect_changes({scope: "staged"})` |
| `rename` | Safe multi-file rename | `gitnexus_rename({symbol_name: "old", new_name: "new", dry_run: true})` |
| `cypher` | Custom graph queries | `gitnexus_cypher({query: "MATCH ..."})` |

## Impact Risk Levels

| Depth | Meaning | Action |
|-------|---------|--------|
| d=1 | WILL BREAK — direct callers/importers | MUST update these |
| d=2 | LIKELY AFFECTED — indirect deps | Should test |
| d=3 | MAY NEED TESTING — transitive | Test if critical path |

## Resources

| Resource | Use for |
|----------|---------|
| `gitnexus://repo/acp-desktop/context` | Codebase overview, check index freshness |
| `gitnexus://repo/acp-desktop/clusters` | All functional areas |
| `gitnexus://repo/acp-desktop/processes` | All execution flows |
| `gitnexus://repo/acp-desktop/process/{name}` | Step-by-step execution trace |

## Self-Check Before Finishing

Before completing any code modification task, verify:
1. `gitnexus_impact` was run for all modified symbols
2. No HIGH/CRITICAL risk warnings were ignored
3. `gitnexus_detect_changes()` confirms changes match expected scope
4. All d=1 (WILL BREAK) dependents were updated

## CLI

- Re-index: `npx gitnexus analyze`
- Check freshness: `npx gitnexus status`
- Generate docs: `npx gitnexus wiki`

<!-- gitnexus:end -->
