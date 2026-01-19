# Vibe Agents Harness

Desktop application for orchestrating multiple Vibe AI agents with integrated terminals, mail, and kanban.

## Tech Stack

- **Electron 28** - Desktop framework
- **React 18** + TypeScript - UI
- **Vite** - Build tool
- **xterm.js** + node-pty - Terminal emulation
- **zustand** - State management
- **electron-store** - Settings persistence
- **Tailwind CSS** - Styling

## Development

```bash
# Install dependencies
npm install

# Start dev server + electron
npm run dev:electron

# Build for production
npm run dist:win
```

## Architecture

### Main Process (`src/main/`)
- `index.ts` - App entry, window management
- `pty.ts` - PTY spawning with node-pty, auto-injects "report as AgentName"
- `store.ts` - Settings persistence with electron-store
- `preload.ts` - Context bridge for renderer

### Renderer Process (`src/renderer/`)
- `App.tsx` - Root component
- `components/Terminal/` - xterm.js terminal grid
- `components/Layout/` - TitleBar, sidebars
- `stores/appStore.ts` - Zustand state

### Shared (`src/shared/`)
- `types.ts` - TypeScript interfaces, IPC channels

## Key Features

### Phase 1 (MVP)
- [x] Electron + React + Vite scaffold
- [x] 4-pane terminal grid with xterm.js
- [x] Agent auto-injection ("report as X")
- [x] Grid/Focus layouts
- [x] Settings persistence
- [ ] Keyboard shortcuts

### Phase 2
- [ ] Mail sidebar (Agent Mail MCP integration)
- [ ] Unread badges

### Phase 3
- [ ] Kanban sidebar
- [ ] Drag-and-drop tasks

## Agent Configuration

Default agents (configurable in settings):
- **BAPert** - Coordinator (top-right)
- **DotNetPert** - Backend (bottom-left)
- **NextPert** - Frontend (top-left)
- **QAPert** - QA (bottom-right)

## IPC Channels

| Channel | Direction | Purpose |
|---------|-----------|---------|
| `pty:spawn` | Renderer → Main | Spawn PTY for agent |
| `pty:write` | Renderer → Main | Send input to PTY |
| `pty:data` | Main → Renderer | PTY output |
| `settings:get/set` | Both | Settings sync |

## External Services

- **Agent Mail MCP**: `http://10.0.0.220:5050`
- **Vibe API**: `https://api.idealvibe.online`

## Spec Reference

Full specification: `E:\Repos\Agents\BAPert\specs\planned\VIBE_AGENTS_HARNESS_SPEC.md`
