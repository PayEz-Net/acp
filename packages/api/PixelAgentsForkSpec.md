# ACP Visual Office — Pixel Agents Fork Spec

## What We're Building

A visual office panel where AI agents appear as pixel art characters sitting at desks, typing, reading, walking around, and receiving mail. Integrates with vibesql-mail for agent state and communication. Fork of Pixel Agents (MIT licensed) adapted to use our mail system instead of Claude Code JSONL transcripts.

## Reference Material

- Pixel Agents repo: https://github.com/pablodelucca/pixel-agents (MIT license, fork this)
- Office tileset: https://donarg.itch.io/officetileset ($2 per dev, commercial use OK)
- Pixel Agents VS Code extension: https://marketplace.visualstudio.com/items?itemName=pablodelucca.pixel-agents

## What Changes From Pixel Agents

### 1. Agent Source: vibesql-mail server instead of Claude Code JSONL

Current Pixel Agents reads Claude Code's JSONL transcript files to detect what agents are doing. Replace with vibesql-mail SSE stream.

Remove:
- transcriptParser.ts (JSONL parsing)
- fileWatcher.ts (JSONL file monitoring)
- The `claude --session-id` terminal launch

Replace with:
- mailClient.ts — connects to `GET /v1/mail/stream/office` (new SSE endpoint that broadcasts all activity)
- Agent state derived from mail activity:
  - Agent sends a message → typing animation for 3s
  - Agent receives a message → speech bubble with subject line
  - Agent reads a message → reading animation for 2s
  - Agent idle (no activity for 60s) → idle/wandering
  - Agent registered but never active → sitting idle at desk

### 2. Agent Registry: from mail server, not manual "+ Agent" button

On startup, fetch `GET /v1/mail/agents` and auto-populate the office:
- Each registered agent gets a desk and character
- Agent name appears as label above character
- Agent role shown on hover
- Agent profile (the .md soul from setup wizard) shown in a side panel on click
- New agents registered via setup wizard auto-appear (SSE event)

Keep the "+ Agent" button but wire it to `POST /v1/mail/agents`.

### 3. Mail Visualization

Speech bubbles show mail activity:
- New mail received: bubble shows "Mail from {sender}: {subject}" for 5s
- Sending mail: character does typing animation, bubble shows "Sending to {recipient}..."
- Unread count: small badge number above character's head
- Click speech bubble → opens message in side panel (read-only)

### 4. Side Panel (new)

Right side panel shows:
- Agent profile (from .md soul file)
- Recent mail (last 5 messages to/from this agent)
- Agent status (active/idle/last seen)
- Quick compose button (opens simple send form)

### 5. Activity Feed (new, bottom panel)

Scrolling feed showing real-time team activity:
```
10:07a  NextPert → BAPert: "Skills done"
10:05a  QAPert → NextPert: "Review PASS"
10:02a  DotNetPert registered
9:58a   BAPert → QAPert: "Code Review Request"
```

Fed by SSE stream. Compact one-liner format.

### 6. Standalone Mode (not just VS Code)

Build as BOTH:
- VS Code/Cursor extension (fork of Pixel Agents, same webview approach)
- Standalone Electron app (same React webview, runs independently)

The webview React code is identical in both modes. Only the host wrapper differs.

Electron app:
```
npx vibesql-office
```

### 7. Character Expansion

Current Pixel Agents has 6 character sprites (16x32 pixels, 7 frames per row).

Phase 1: Use existing 6 with palette swaps (hue shifting already works). 6 base designs × multiple color variations = ~18 visually distinct characters.

Phase 2: Commission additional sprite sheets following the same format.

The setup wizard's 3 default agents (Strategist, Engineer, Designer) each get a distinct character design + color.

## Server Side (Minimal Changes)

New SSE endpoint needed:

`GET /v1/mail/stream/office`

Broadcasts ALL agent activity (not filtered to one agent):
```
event: message-sent
data: {"from":"BAPert","to":["NextPert"],"subject":"Code Review","timestamp":"..."}

event: message-read
data: {"agent":"NextPert","message_id":42,"timestamp":"..."}

event: agent-registered
data: {"name":"QAPert","role":"QA","timestamp":"..."}

event: agent-active
data: {"agent":"BAPert","timestamp":"..."}

: heartbeat (every 30s)
```

## Repo Structure

Fork pablodelucca/pixel-agents to PayEz-Net/vibesql-office:

```
vibesql-office/
├── extension/              # VS Code/Cursor extension wrapper
│   ├── src/
│   │   ├── extension.ts
│   │   ├── OfficeViewProvider.ts
│   │   └── mailBridge.ts   # Routes mail SSE → webview messages
│   └── package.json
├── electron/               # Standalone Electron wrapper
│   ├── main.ts
│   ├── preload.ts
│   └── package.json
├── webview/                # Shared React UI (used by both hosts)
│   ├── src/
│   │   ├── App.tsx
│   │   ├── mailClient.ts   # SSE connection to vibesql-mail-server
│   │   ├── agentState.ts   # Derive character state from mail activity
│   │   ├── components/
│   │   │   ├── AgentLabels.tsx
│   │   │   ├── SidePanel.tsx       # Agent profile + recent mail
│   │   │   ├── ActivityFeed.tsx    # Scrolling team activity
│   │   │   ├── BottomToolbar.tsx
│   │   │   ├── SettingsModal.tsx
│   │   │   └── ZoomControls.tsx
│   │   └── office/
│   │       ├── engine/      # Keep from Pixel Agents (gameLoop, renderer, characters, pathfinding)
│   │       ├── layout/      # Keep (tileMap, layoutSerializer, furnitureCatalog)
│   │       └── sprites/     # Keep (spriteCache, spriteData)
│   └── package.json
├── assets/                 # Tileset + sprites (.gitignored, user buys $2 tileset)
│   └── README.md           # "Buy tileset at donarg.itch.io, run npm run import-tileset"
└── README.md
```

## What to Keep From Pixel Agents (as-is)

- office/engine/gameLoop.ts — requestAnimationFrame loop
- office/engine/renderer.ts — canvas render pipeline with z-sorting
- office/engine/characters.ts — state machine (idle/walk/type), BFS pathfinding, wandering
- office/layout/* — tileMap, layoutSerializer, furnitureCatalog
- office/sprites/* — spriteCache, spriteData
- office/colorize.ts — HSB palette swaps
- office/wallTiles.ts — auto-tiling bitmask
- office/floorTiles.ts — floor sprite selection
- Layout editor (paint, erase, place furniture, undo/redo)
- Zoom controls
- Import/export layout JSON

## What to Remove

- transcriptParser.ts (JSONL parsing)
- fileWatcher.ts (JSONL file watching)
- agentManager.ts terminal launch logic
- timerManager.ts permission/waiting timers
- All Claude Code specific detection

## What to Add

- mailClient.ts — EventSource connection to /v1/mail/stream/office
- agentState.ts — map mail events to character states
- SidePanel.tsx — agent profile + recent mail + quick compose
- ActivityFeed.tsx — scrolling activity log
- mailBridge.ts (extension) — routes SSE to webview postMessage
- Electron wrapper for standalone mode

## Implementation Order

1. Fork Pixel Agents, strip Claude-specific code
2. Add mailClient.ts + agentState.ts (SSE → character state)
3. Wire agent registry from GET /v1/mail/agents
4. Speech bubbles for mail notifications
5. Side panel (agent profile + recent mail)
6. Activity feed
7. Electron wrapper
8. Layout editor customizations (if needed)

## Tileset

Each developer buys the $2 tileset from https://donarg.itch.io/officetileset. Raw assets are .gitignored. Repo includes the import script (from Pixel Agents: `npm run import-tileset`).

For open source release, include fallback basic colored rectangles so it runs without the purchased tileset (ugly but functional).

## Verification

1. `npx vibesql-office` opens Electron window showing pixel art office
2. Agents from vibesql-mail-server appear at desks automatically
3. Send a mail via TUI → receiving agent's character shows speech bubble
4. Click agent → side panel shows profile and recent mail
5. Activity feed scrolls with real-time mail events
6. Layout editor works (paint floors, place furniture, save/load)
7. VS Code extension mode works identically to Electron mode
