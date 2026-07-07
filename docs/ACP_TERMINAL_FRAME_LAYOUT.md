# ACP Terminal Frame Layout

Vercel-style terminal frame for every agent pane. Clean output surface, metadata in the footer, chrome stripped from the stream.

## Anatomy of One Terminal Frame

```
┌─────────────────────────────────────────┐
│ ● AgentName    Ready   [KIMI]      □ ▷ ⟳ │  ← Header (identity + controls)
├─────────────────────────────────────────┤
│                                         │
│   Clean agent output goes here.         │  ← Surface (chat / logs / answers)
│   No provider TUI junk.                 │
│                                         │
├─────────────────────────────────────────┤
│ Ready · KIMI · acp-desktop   12 lines ▓▓░ │  ← Footer (per-session status)
├─────────────────────────────────────────┤
│ Message AgentName…                  [➤] │  ← Composer (human input)
└─────────────────────────────────────────┘
```

## Zones

### 1. Header

Purpose: identify the agent and give lifecycle controls.

Contents:
- Status dot + agent status
- Agent display name
- Provider badge (only when team mixes providers)
- Start / stop / restart controls

Does **not** contain:
- Context usage bars
- Token counters
- Keybinding hints
- Input separators

### 2. Surface

Purpose: show the actual agent output — conversation, code, answers, errors.

Rules:
- Strip all provider TUI chrome at the stream normalizer layer.
- Collapse thinking blocks by default.
- Preserve real content: commands, answers, code, errors.
- Max two consecutive blank lines.

Suppressed patterns:
- `yolo agent (...) ...` status bars
- `context: X%` / `(Nk/Mk)` token counters
- `— input` / `— input · N queued` separators
- `ctrl-*: ...` / `shift-tab: ...` / `@: mention files` keybinding hints
- `/feedback`, `/theme`, `thme:` commands
- `↑ to edit · ctrl-s to send immediately` hints
- `⫶` file-path trailers
- Partial / corrupted footer redraws

### 3. Footer

Purpose: surface per-session metadata that the provider buries in the stream.

Contents:
- Agent status with dot
- Provider / runtime
- Truncated working path / repo path
- Output line count
- Thinking-block count (if any)
- Context-usage mini-bar (placeholder until real model exists)

Does **not** contain:
- Long text
- Scrolling content
- Provider hints that belong in the surface

### 4. Composer

Purpose: let the human type to the agent.

Rules:
- Fixed to the bottom of the frame.
- Placeholder: `Message {AgentName}…`
- Disabled when agent is offline.

## Design Principles

1. **Surface is sacred.** If it is not agent output, it does not belong in the surface.
2. **Footer owns metadata.** Status, provider, path, counts, and usage go here.
3. **Header owns identity.** Agent name, status, provider badge, lifecycle controls.
4. **Suppress, don't style.** Do not try to make provider TUI lines pretty — drop them before they reach the pane.
5. **One frame per agent.** Every agent gets the same four-zone layout so the user never has to relearn the UI.

## Implementation Map

| Zone | Component | File |
|------|-----------|------|
| Header | `TerminalPane` header | `src/renderer/components/Terminal/TerminalPane.tsx` |
| Surface | `UnifiedTerminal` | `src/renderer/components/Terminal/UnifiedTerminal.tsx` |
| Footer | `TerminalFooter` | `src/renderer/components/Terminal/TerminalPane.tsx` |
| Composer | `UnifiedTerminal` input | `src/renderer/components/Terminal/UnifiedTerminal.tsx` |
| Stream hygiene | `TerminalStreamNormalizer` | `src/renderer/lib/terminalStream.ts` |

## Future Enhancements

- Real per-agent context/token model surfaced in footer.
- Current working directory extracted from `cd` / `Set-Location` commands.
- Active git branch extracted from git output.
- Last command / current task hint in footer.
