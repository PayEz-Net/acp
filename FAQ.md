# ACP — Frequently Asked Questions

## Getting Started

### What is ACP?
ACP (Agent Collaboration Platform) is a desktop app that runs a team of AI agents alongside your code. You pick a project, we assemble the team, and you direct the work via natural language. Agents coordinate with each other through agent mail — no babysitting required.

### How do I install ACP?
Download the latest `.exe` (Windows) or `.dmg` (Mac) from [GitHub Releases](https://github.com/PayEz-Net/acp/releases). Run the installer and launch ACP from your Start menu or desktop shortcut.

### What do I need to get started?
- A PayEz/idealvibe account (sign up with email or Google)
- A project to work on (or create one during first-run)
- That's it. The installer handles the rest.

---

## Common Issues

### Switching projects requires a restart
**Q: I picked a different project but my agents are still working on the old one.**

A: Switching projects mid-session is coming in a future update. For now, use **Restart ACP** after picking a new project. Your agents will re-assemble on the correct project on next launch.

*Why:* Each project has its own agent team, working directory, and lifecycle state. A hot-switch would require tearing down and re-spawning every agent process safely — that's Wave C, currently in development.

### Settings are read-only in the app
**Q: Why can't I edit project settings inside ACP?**

A: Project settings live on [idealvibe.online](https://idealvibe.online). Edit them there, and ACP picks up the changes within 60 seconds. Click **Project settings** in ACP to view the current state, then use the deeplink to open the edit page in your browser.

*Why:* Settings affect cloud-side behavior (billing, team composition, API keys). Keeping the edit surface on the web ensures all clients see the same truth.

### BAPert-Jon shows an empty profile
**Q: My BAPert-Jon agent has no profile information.**

A: BAPert-Jon is a liaison agent that bridges human intent (you) and agent coordination (BAPert). His profile is intentionally minimal — he doesn't need a deep skill stack because his job is translation, not execution. If you need a fully-profiled coordinator, use **BAPert** (the primary coordinator).

### My agent crashed and the terminal is frozen
**Q: I killed a Claude process and now the pane is black.**

A: Click the **Restart agent** button in that pane, or restart ACP. Wave B ships crash recovery UX that detects dead PTY children and offers a one-click restart. If the restart button doesn't appear, a full ACP restart will clear it.

### The backend shows "Disconnected"
**Q: The radio icon in the top-right is red.**

A: The ACP API sidecar (localhost:3001) is not responding. Common causes:
1. **Port conflict** — another app is using port 3001. Quit the other app or restart ACP.
2. **Antivirus / firewall** — Windows Defender or corporate policy may be blocking the local server. Add an exception for `ACP.exe`.
3. **Corrupted install** — reinstall ACP.

If the issue persists, check **View → Logs** (or `%APPDATA%/ACP/logs`) and file a GitHub issue.

---

## Agents & Teams

### How do I add a specialist agent to my project?
Open the **Team Editor** (users icon in the top bar) or wait for the first-run picker. Browse the Specialist Library, click **Engage** on the agent you want, customize their name and prompt if desired, and add them to your team.

### What's the difference between full-time and contractor agents?
- **Full-time** — loads automatically when ACP starts, participates in standups, receives mail
- **Contractor** — available on demand, dormant otherwise. Invoke them via agent mail when needed

### Can I rename an agent?
Yes. Click **Configure** on any agent card and edit the **Display name**. The archetype name (e.g., `BAPert`) stays fixed for system routing, but the display name is what you see in the UI.

---

## Privacy & Security

### Does ACP send my code to the cloud?
No. Your code stays on your machine. ACP communicates with the cloud for:
- Authentication (IDP)
- Project metadata (team composition, settings)
- Agent mail routing (encrypted, scoped to your project)

Agent execution happens locally via PTY shells.

### Who can see my agent mail?
Only agents on your project team. Mail is scoped to the active project — cross-project bleed is blocked by the cloud sidecar.

### Is this safe for production code?
ACP v1 is an **internal developer preview**. It runs agent processes with your full user privileges. Use it on code you're comfortable exposing to automated tools. Do not install on shared workstations.

---

## Contributing & Support

### I found a bug. Where do I report it?
[GitHub Issues](https://github.com/PayEz-Net/acp/issues) — include your ACP version, OS, and steps to reproduce.

### How do I request a feature?
Open a GitHub Discussion or mail your coordinator agent (BAPert) with the tag `[FEATURE REQUEST]`.

### Can I self-host the backend?
Yes. Fork the `main` branch and wire your own IDP + API endpoints. The Pro branch is pre-configured for PayEz infrastructure.
