# ACP — Agent Collaboration Platform (Desktop Shell)

This is the **desktop UI** of ACP. The backend API lives at `E:\Repos\acp-api`.

ACP is one product with two halves:

| Layer | Repo | Tech |
|-------|------|------|
| **Desktop Shell** | `E:\Repos\acp-desktop` (this repo) | Electron 28 + React 18 + TypeScript + Vite |
| **Backend API** | `E:\Repos\acp-api` | Node.js + Express (migrating to TypeScript) |

## What This Repo Contains

The Electron desktop app that humans use to orchestrate, observe, and interact with the AI agent team.

## Tech Stack

- **Electron 28** — Desktop framework
- **React 18** + **TypeScript** — UI
- **Vite** — Build tool
- **node-pty** — PTY spawning (each pane runs a Claude Code session)
- **`src/main/terminalScreen.ts`** — terminal emulation. A headless screen model in the
  MAIN process interprets ConPTY cursor addressing and emits frame updates over IPC;
  the renderer paints those frames. There is NO xterm.js in this app.
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
│   │   │   ├── Terminal/  terminal grid (paints frames from terminalScreen.ts)
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

Dev server runs on port 40020. Use `npm run kill-port` if the port is stuck.

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

- **ACP Backend API**: `E:\Repos\acp-api` (port 3001)
- **Agent Mail**: `https://api.idealvibe.online` (enterprise auth)
- **VibeSQL**: `http://localhost:52411` (vibe-serverapi, HMAC auth)
- **Agent Mail CLI**: bundled at `agent-mail-cli/`

## Note on `agent-collaboration-platform`

`E:\Repos\agent-collaboration-platform` is an older fork of this repo. **acp-desktop is canonical.** Key difference: this repo has `@microsoft/signalr` for real-time; the old fork has `@dicebear` for avatars but no SignalR.

## Key Specs

- **Chat Architecture**: `E:\Repos\Agents\BAPert\specs\ACP-agent-chat-architecture-v1.md`
- **Harness Spec**: `E:\Repos\Agents\BAPert\specs\planned\VIBE_AGENTS_HARNESS_SPEC.md`
- **Harness Analysis**: `E:\Repos\acp-api\docs\acp_harness_analysis.md`

<!-- gitnexus:start — DISABLED 2026-07-29 (Jon): the GitNexus MCP tools are not
     connected to this project, so the "MUST run impact analysis before editing any
     symbol" mandate below directed agents at tools that do not exist. Everything
     down to the gitnexus:end marker is inert. To re-enable, delete this comment
     wrapper and the closing marker's comment terminator.

# GitNexus — Code Intelligence

This project is indexed by GitNexus as **acp** (4446 symbols, 9180 relationships, 300 execution flows). Use the GitNexus MCP tools to understand code, assess impact, and navigate safely.

> Index stale? Run `node .gitnexus/run.cjs analyze` from the project root — it auto-selects an available runner. No `.gitnexus/run.cjs` yet? `npx gitnexus analyze` (npm 11 crash → `npm i -g gitnexus`; #1939).

## Always Do

- **MUST run impact analysis before editing any symbol.** Before modifying a function, class, or method, run `impact({target: "symbolName", direction: "upstream"})` and report the blast radius (direct callers, affected processes, risk level) to the user.
- **MUST run `detect_changes()` before committing** to verify your changes only affect expected symbols and execution flows. For regression review, compare against the default branch: `detect_changes({scope: "compare", base_ref: "main"})`.
- **MUST warn the user** if impact analysis returns HIGH or CRITICAL risk before proceeding with edits.
- When exploring unfamiliar code, use `query({search_query: "concept"})` to find execution flows instead of grepping. It returns process-grouped results ranked by relevance.
- When you need full context on a specific symbol — callers, callees, which execution flows it participates in — use `context({name: "symbolName"})`.
- For security review, `explain({target: "fileOrSymbol"})` lists taint findings (source→sink flows; needs `analyze --pdg`).

## Never Do

- NEVER edit a function, class, or method without first running `impact` on it.
- NEVER ignore HIGH or CRITICAL risk warnings from impact analysis.
- NEVER rename symbols with find-and-replace — use `rename` which understands the call graph.
- NEVER commit changes without running `detect_changes()` to check affected scope.

## Resources

| Resource | Use for |
|----------|---------|
| `gitnexus://repo/acp/context` | Codebase overview, check index freshness |
| `gitnexus://repo/acp/clusters` | All functional areas |
| `gitnexus://repo/acp/processes` | All execution flows |
| `gitnexus://repo/acp/process/{name}` | Step-by-step execution trace |

## CLI

| Task | Read this skill file |
|------|---------------------|
| Understand architecture / "How does X work?" | `.claude/skills/gitnexus/gitnexus-exploring/SKILL.md` |
| Blast radius / "What breaks if I change X?" | `.claude/skills/gitnexus/gitnexus-impact-analysis/SKILL.md` |
| Trace bugs / "Why is X failing?" | `.claude/skills/gitnexus/gitnexus-debugging/SKILL.md` |
| Rename / extract / split / refactor | `.claude/skills/gitnexus/gitnexus-refactoring/SKILL.md` |
| Tools, resources, schema reference | `.claude/skills/gitnexus/gitnexus-guide/SKILL.md` |
| Index, status, clean, wiki CLI commands | `.claude/skills/gitnexus/gitnexus-cli/SKILL.md` |

gitnexus:end -->

