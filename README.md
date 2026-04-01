# ACP — Agent Collaboration Platform

Desktop application for orchestrating AI agent teams. ACP provides a terminal grid where each pane runs an AI agent session (Claude Code or Kimi Code CLI) with an assigned agent identity, plus a backend API for agent collaboration, messaging, and task management.

## 🎉 New: Kimi Code CLI Support

ACP now supports **Kimi Code CLI** as the default AI provider! Agents run in `--yolo` mode for fast, interruption-free collaboration.

```bash
# Kimi starts automatically with --yolo (skip permissions)
# Or switch to Claude in Settings
```

| Feature | Claude | Kimi |
|---------|--------|------|
| Skip permissions | `--dangerously-skip-permissions` | `--yolo` |
| Skills location | `.claude/skills/` | `.kimi/skills/` |
| Cloud profiles | ✅ | ✅ |
| Agent mail | ✅ | ✅ |
| Real-time push | ✅ | ✅ |

## Architecture

```
acp/
├── packages/
│   ├── api/          Node.js + Express backend
│   │   ├── api/        REST routes (bootstrap, exec, messaging, kanban, party)
│   │   ├── collaboration/  Multi-agent chat, mail, broadcast
│   │   ├── autonomy/       Autonomous operation + escalation
│   │   ├── core/           Agent lifecycle (bootstrap, exec, self-modify)
│   │   ├── storage/        VibeSQL data layer
│   │   └── config.ts       Environment configuration
│   └── desktop/      Electron 28 + React 18 + Vite
│       ├── src/main/       Electron main process (PTY, auth, IDP)
│       ├── src/renderer/   React UI (terminal grid, sidebars)
│       └── src/shared/     Shared types + IPC channels
```

## Quick Start

```bash
# 1. Clone and install
git clone https://github.com/PayEz-Net/acp.git
cd acp
cp .env.example .env
# Edit .env with your Vibe credentials

# 2. Install dependencies
cd packages/api && npm install
cd ../desktop && npm install
cd ../..

# 3. Run
# Terminal 1: API server
cd packages/api && npm start

# Terminal 2: Desktop app
cd packages/desktop && npm run dev:electron
```

## Requirements

- **Node.js 20+**
- **VibeSQL** — local instance or `api.idealvibe.online` (see [VibeSQL setup](#vibesql))
- **Redis** (optional, for real-time features)
- **Claude Code CLI** or **Kimi Code CLI** — at least one installed

## Configuration

Copy `.env.example` to `.env` and configure:

| Variable | Required | Description |
|----------|----------|-------------|
| `VIBESQL_URL` | Yes | VibeSQL endpoint (`http://localhost:5173` for local) |
| `VIBE_CLIENT_ID` | Yes | Your Vibe client ID |
| `VIBE_HMAC_KEY` | Yes | HMAC signing key for Vibe API auth |
| `VITE_IDP_URL` | Yes | PayEz IDP URL for authentication |
| `REDIS_URL` | No | Redis for real-time messaging (default: `localhost:6379`) |
| `ACP_AGENTS` | No | Comma-separated agent names (default: `DotNetPert,BAPert,NextPert,QAPert`) |

## Agent Grid

Default 4-pane layout (configurable):

| Position | Agent | Role |
|----------|-------|------|
| Top-left | NextPert | Frontend (Next.js) |
| Top-right | BAPert | Coordinator / BA |
| Bottom-left | DotNetPert | Backend (.NET) |
| Bottom-right | QAPert | QA / Testing |

Each pane spawns an AI agent session via `node-pty` and auto-injects the agent identity.

## AI Provider Selection

Switch between Claude and Kimi in the app:

1. Open **Settings** (gear icon)
2. Go to **AI Provider** section
3. Select **Kimi** or **Claude**
4. Kill and restart agents to apply

### Kimi Skills

Kimi loads skills from `.kimi/skills/`:

```
.kimi/skills/
├── agent-onboarding/   # "report as" handler, cloud profile loading
├── vibe-sql/           # Database queries
└── gitnexus-code/      # Code intelligence
```

### Agent Onboarding

When agents spawn, they automatically:
1. Connect to VibeSQL cloud
2. Load identity from `vibe.global_vibe_agents`
3. Load skills from `vibe.agent_skills`
4. Check inbox for pending mail

```
✓ {AgentName} initialized
⚡ Connecting to VibeSQL cloud...
✓ Profile loaded
✓ Ready for assignments
```

## VibeSQL

ACP stores all data in VibeSQL (PostgreSQL). Two options:

**Option A — Local VibeSQL micro** (recommended for development)
```bash
# Run a local VibeSQL instance
docker run -p 5173:5173 idealvibe/vibesql-micro
# Set VIBESQL_URL=http://localhost:5173 in .env
```

**Option B — Hosted** (api.idealvibe.online)
```bash
# Set VIBESQL_URL=https://api.idealvibe.online in .env
# You'll need a VIBE_CLIENT_ID and VIBE_HMAC_KEY
```

## Tech Stack

| Layer | Technologies |
|-------|-------------|
| **Desktop** | Electron 28, React 18, TypeScript, Vite, xterm.js, node-pty |
| **API** | Node.js, Express, TypeScript (migrating from JS) |
| **Real-time** | @microsoft/signalr, Server-Sent Events |
| **Storage** | VibeSQL (PostgreSQL) |
| **State** | zustand, electron-store |
| **Styling** | Tailwind CSS |
| **AI Providers** | Claude Code CLI, Kimi Code CLI |

## Changelog

### 2025-04-01 — Kimi Support
- Added Kimi Code CLI as default AI provider
- Added `--yolo` mode for skip-permissions workflow
- Added `.kimi/skills/` for project-level context
- Added AI Provider toggle in Settings
- Improved agent onboarding with cloud profile loading

## License

MIT
