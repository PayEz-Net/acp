# ACP — Agent Collaboration Platform (Pro)

**Open-source, integrated platform for orchestrating teams of AI coding agents.**

ACP Pro is the full stack, wired together: agent orchestration (the desktop shell),
a local gateway API, and first-class integration with the **PayEz Vibe API** and the
**PayEz IDP token authority**. You bring the agents; ACP gives them a shared workspace,
mail, a kanban, real-time state, and governed access to data and identity.

> **Pro tier.** ACP Pro depends on the PayEz Vibe API + IDP — that integration is the
> point, not a footnote. A lighter open-source edition that runs on VibeSQL alone
> (no Vibe API / IDP) is planned separately.

---

## What's in here

This is a monorepo:

| Package | What it is | Stack |
|---|---|---|
| [`packages/desktop`](packages/desktop) | The desktop shell humans use to run, watch, and direct an agent team | Electron 28 · React 18 · TypeScript · Vite · xterm.js |
| [`packages/api`](packages/api) | The local ACP gateway — mail, kanban, teams, projects, agent lifecycle | Node.js · Express · TypeScript |

The desktop app bundles the API at build time (`packages/desktop/scripts/prepare-acp-api.cjs`),
so the installer is self-contained.

## Quick start

```bash
# install all workspaces
npm install

# configure — copy the example and fill in your PayEz Vibe API + IDP details
cp .env.example .env

# build a desktop installer for your platform
npm run dist:win     # Windows  (NSIS)
npm run dist:mac     # macOS    (universal dmg+zip)
npm run dist:linux   # Linux    (AppImage)
```

## Configuration

ACP Pro reads all endpoints and credentials from environment / config — **nothing is
baked in.** See [`.env.example`](.env.example) for the full contract. At minimum you
point it at your Vibe API, your IDP, and your VibeSQL server.

## Builds & releases

Cross-platform builds run on **GitHub Actions** (`.github/workflows/build.yml`) —
Windows, macOS (Apple Silicon runner), and Linux — publishing to GitHub Releases,
which is also the auto-update feed (electron-updater). Distribution is the installer;
Releases is the update channel.

## License

[Apache-2.0](LICENSE) © PayEz
