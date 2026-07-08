# ACP Desktop — Slash Commands

**Author:** BAPert  
**Status:** Approved — work order issued  
**Related:** `acp-terminal` skill, `acp-autonomy` skill, `TERMINAL_PROVIDER_UNIFICATION_PRD.md`

---

## 1. Context

The four-pane terminal UI now renders clean, readable agent output. Each pane has a message input at the bottom. Users currently type plain text that is forwarded to the active agent's PTY. There is no fast way to:

- Spawn, kill, or restart an agent
- Send mail to another agent without switching panes
- Change layout, zoom, or theme
- Start/stop unattended mode
- Check standup or agent status

Slash commands give users keyboard-driven control without leaving the chat surface.

## 2. Goal

Add a small, predictable slash-command language to the per-agent input box. Commands should feel native to the terminal chat UI and map directly to existing ACP API endpoints.

## 3. Outcomes

- Users can manage agent lifecycle from any input box.
- Users can send cross-agent mail and check status without mouse navigation.
- UI state (layout, zoom, theme) is controllable via commands.
- Commands are discoverable through `/help` and autocomplete.

## 4. Non-goals

- We are not building a full shell or REPL.
- We are not adding provider-specific commands (Claude/Kimi/Codex) yet.
- We are not replacing the existing menu/button chrome.

## 5. Command Taxonomy

Commands are typed into an agent's message input. Some commands act on the current agent (the pane they are typed in), some are global.

### 5.1 Global / UI commands

| Command | Scope | Behavior |
|---------|-------|----------|
| `/help [command]` | Global | Show all commands, or detail for one |
| `/clear [all \| <agent>]` | Global | Clear output for current pane, all panes, or named agent |
| `/layout grid \| horizontal \| vertical \| focus <agent>` | Global | Change pane layout |
| `/zoom <agent> \| reset` | Global | Maximize one agent pane or restore grid |
| `/theme dark \| light \| high-contrast` | Global | Switch UI theme |
| `/fontsize <size>` | Global | Set base terminal font size (px) |
| `/broadcast <message>` | Global | Send the same prompt to all active agents |

### 5.2 Agent lifecycle commands

Typed in an agent's input box, these act on that agent unless a target is specified.

| Command | Scope | Maps to ACP API |
|---------|-------|-----------------|
| `/spawn [agent]` | Current / named | `POST /v1/lifecycle/agents/{agent}/spawn` |
| `/kill [agent]` | Current / named | `POST /v1/lifecycle/agents/{agent}/kill` |
| `/restart [agent]` | Current / named | Kill then spawn |
| `/status [agent]` | Current / named | `GET /v1/lifecycle/agents/{agent}/status` |
| `/resize <cols>x<rows> [agent]` | Current / named | `POST /v1/lifecycle/agents/{agent}/resize` |
| `/runtime <kimi \| claude \| codex> [agent]` | Current / named | Spawn override for next `/restart` |
| `/workdir <path> [agent]` | Current / named | Used on next `/spawn` or `/restart` |

### 5.3 Communication commands

| Command | Scope | Maps to ACP API |
|---------|-------|-----------------|
| `/mail <agent> <message>` | Global | `POST /v1/mail/send` |
| `/inbox [agent]` | Current / named | `GET /v1/mail/inbox/{agent}` |
| `/reply <msgId> <message>` | Current agent | `POST /v1/mail/reply/{msgId}` |

### 5.4 Autonomy / workflow commands

| Command | Scope | Maps to ACP API |
|---------|-------|-----------------|
| `/unattended start [hours] [lead]` | Global | `POST /v1/autonomy/unattended/start` |
| `/unattended stop [reason]` | Global | `POST /v1/autonomy/unattended/stop` |
| `/autonomy status` | Global | `GET /v1/autonomy/status` |
| `/standup` | Global | `GET /v1/autonomy/standup` |
| `/standup add <agent> <summary>` | Global | `POST /v1/autonomy/standup` |

### 5.5 Context commands

| Command | Scope | Behavior |
|---------|-------|----------|
| `/profile [agent]` | Current / named | Show agent profile card |
| `/skills [agent]` | Current / named | List loaded skills |
| `/context load <file>` | Current agent | Load a file/path as context for the current agent |
| `/context clear` | Current agent | Clear loaded context |

## 6. Syntax Rules

1. Commands start with `/` and are parsed before PTY input.
2. Known commands are parsed and executed. Unknown `/...` text is sent to the PTY unchanged so provider-specific commands are not accidentally intercepted.
3. Arguments with spaces must be quoted: `/mail QAPert "Please review PRD"`.
4. `[agent]` is optional; when omitted, the command targets the agent whose input box is focused.
5. Global commands (e.g. `/layout`, `/unattended`) show feedback in the current pane and apply to the whole window.

## 7. MVP Command Set

For the first slice, implement only:

- `/help`
- `/clear [all]`
- `/layout grid | horizontal | vertical`
- `/zoom <agent> | reset`
- `/spawn`, `/kill`, `/restart` (current agent)
- `/status` (current agent)
- `/mail <agent> <message>`
- `/inbox`
- `/unattended start | stop`
- `/standup`

Everything else is Phase 2.

## 8. UI Behavior

- Typing `/` shows an autocomplete popup with command names and one-line descriptions.
- Commands execute on Enter (Shift+Enter still inserts a newline for multi-line prompts).
- Command output is rendered as a system message in the current pane, not sent to the PTY.
- A failed command is shown in red with the API error message.

## 9. Keyboard Shortcuts

Shortcuts operate from the composer / terminal surface unless noted as global.

| Shortcut | Scope | Behavior |
|----------|-------|----------|
| `Enter` | Composer | Send current input to the active PTY or execute a slash command. |
| `Shift+Enter` | Composer | Insert a newline (future multi-line prompts). |
| `Ctrl+S` / `Cmd+S` | Composer | Send current input (same as `Enter`). This is the "push my question up" shortcut. |
| `Escape` | Composer / Surface | If staged images exist, clear them; otherwise send `ESC` (`\u001b`) to the PTY to interrupt the running process. |
| `Ctrl+C` / `Cmd+C` | Composer / Surface | If text is selected, copy. Otherwise send `SIGINT` (`\u0003`) to the PTY. |
| `Ctrl+V` / `Cmd+V` | Composer / Surface | Paste clipboard content using the native paste path. Image blobs are staged as previews. |
| `Ctrl+M` / `Cmd+M` | Global | Toggle mail sidebar. |
| `Ctrl+L` / `Cmd+L` | Global | Toggle logs panel. |
| `/` | Composer | Open slash-command autocomplete. |
| `Tab` | Composer | Accept highlighted autocomplete suggestion, or send a literal tab to the PTY if no autocomplete is open. |
| `Up/Down` | Composer | Navigate autocomplete menu; outside autocomplete, recall command history (Phase 2). |

## 10. Acceptance Criteria

1. All MVP commands parse correctly from any agent input box.
2. `/help` lists MVP commands with syntax examples.
3. `/spawn`, `/kill`, `/restart` invoke the correct ACP lifecycle endpoints.
4. `/mail` sends a mail envelope and shows a confirmation.
5. `/layout` and `/zoom` update the renderer layout store within 100 ms.
6. `/clear` removes rendered lines from the target pane without killing the agent.
7. Unknown `/...` text is sent to the PTY unchanged (no accidental interception). Known commands are parsed and executed.
8. Command errors are surfaced as inline system messages.
9. Autocomplete appears within 50 ms of typing `/`.
10. `Ctrl+S` / `Cmd+S` in the composer sends the current input.
11. All shortcuts listed in §9 work and do not conflict with OS/browser defaults in the packaged app.

## 11. Open Questions

1. Should there be a dedicated global command bar (e.g. `Ctrl+K`) separate from per-agent inputs?
2. Do we want command history (up-arrow recalls previous commands)?
3. Should `/broadcast` wait for all agents to be idle, or send immediately?
4. Which keybinding opens a command palette instead of typing `/`?

## 12. Suggested Phasing

**Phase 1 — Core lifecycle + UI + Mail + Autonomy (MVP)**
- `/help`, `/clear`, `/layout`, `/zoom`, `/spawn`, `/kill`, `/restart`, `/status`
- `/mail`, `/inbox`, `/unattended`, `/standup`

**Phase 2 — Replies + context + advanced**
- `/reply`, `/profile`, `/skills`, `/context`, `/resize`, `/runtime`, `/workdir`, `/broadcast`

---

*Ready for review. BAPert will convert to work orders once direction is confirmed.*
