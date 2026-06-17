# ACP Help

## Getting Started

### First Launch
1. **Sign in** — Use magic-link (email) or Google OAuth
2. **Pick a project** — Choose an existing project or create one
3. **Meet your team** — Your default team auto-assembles (BAPert, QAPert, and specialists if engaged)
4. **Start working** — Click any agent to open a terminal session

### The Interface

**Top Bar**
- **Project picker** — Switch between projects (requires restart; see FAQ)
- **Layout buttons** — Grid, Focus Left, Focus Right
- **Sidebar toggles** — Mail, Documents, Standup, Kanban, Chat, Contractors, Team Editor
- **Status icon** — Green = backend connected, Red = disconnected

**Main Area**
- **Agent terminals** — Each agent runs in its own PTY pane
- **Agent mail** — Click the mail icon to see inter-agent coordination
- **Kanban** — Task board for tracking work

---

## Projects

### Creating a Project
Click the project name in the top bar → **Create project**. Projects live on [idealvibe.online](https://idealvibe.online); ACP mirrors them locally.

### Switching Projects
Pick a different project from the dropdown, then **Restart ACP**. Hot-switching is coming in a future update.

### Project Settings
Click the **gear icon** next to the project name. Settings are read-only in ACP; edit them on idealvibe.online and changes sync within 60 seconds.

---

## Agents

### The Default Team
Every project starts with:
- **BAPert** — Coordinator, business analyst, project manager
- **QAPert** — Quality assurance, testing, acceptance criteria

### Engaging Specialists
Open the **Team Editor** (users icon) or wait for the first-run picker. Browse categories:
- Code Quality (reviewers, optimizers)
- Security (auditors, vulnerability hunters)
- Language Specialists (TypeScript, Python, Rust, Go)
- DevOps / Infra
- Documentation

Click **Engage** on any specialist to add them to your project team.

### Agent States
- **Online** — Agent is active and responsive
- **Working** — Agent is processing a task
- **Offline** — Agent is not loaded or has crashed

### Sending Mail
Click the **mail icon** in any agent's terminal pane to send a message. Mail is scoped to your current project.

---

## Workflows

### Standup
Click the **clipboard icon** in the top bar to open the standup panel. Agents report status, blockers, and next steps.

### Kanban
Click the **layout list icon** to open the task board. Create cards, assign agents, and track progress.

### Documents
Click the **file text icon** to open the document sidebar. View specs, notes, and generated artifacts.

---

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Ctrl+Shift+M` | Toggle Mail sidebar |
| `Ctrl+Shift+K` | Toggle Kanban |
| `Ctrl+Shift+C` | Toggle Chat |
| `Ctrl+Shift+I` | Open DevTools (dev mode) |
| `Ctrl+W` | Close current agent pane |
| `Ctrl+=` | Increase terminal font size |
| `Ctrl+-` | Decrease terminal font size |

---

## Troubleshooting

See [FAQ.md](FAQ.md) for detailed troubleshooting.

**Quick fixes:**
- **Backend disconnected** — Restart ACP; check if port 3001 is in use
- **Agent crashed** — Click Restart agent in the pane, or restart ACP
- **Can't switch project** — This is expected; use Restart ACP after picking a new project
- **Settings won't save** — Edit settings on idealvibe.online, not in ACP

---

## Support

- **Email:** support@idealvibe.online
- **GitHub Issues:** [github.com/PayEz-Net/acp/issues](https://github.com/PayEz-Net/acp/issues)
- **In-app:** Avatar menu → Send feedback
