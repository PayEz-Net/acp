# ACP Desktop

Agent Collaboration Platform — Windows desktop application for orchestrating AI agent collaboration.

## Install

```bash
npm install -g acp-desktop
```

## Run installer

```bash
npx acp-desktop
```

Or after global install:

```bash
acp-desktop
```

## What is ACP?

ACP is a desktop shell (Electron + React + TypeScript) that spawns multiple Claude Code sessions in a grid layout, auto-injects agent identity, and provides real-time chat, mail, and kanban coordination.

- **Desktop Shell**: Electron 28 + React 18 + TypeScript + Vite
- **Backend API**: Node.js + Express (port 3001)
- **Agent Team**: 4-pane grid with NextPert, BAPert, DotNetPert, QAPert

Learn more: https://idealvibe.online/acp/docs

## System Requirements

- Windows 10/11 (x64)
- Node.js 18+ (for `npx` / `npm install -g`)

## License

MIT
