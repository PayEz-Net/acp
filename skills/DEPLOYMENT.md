# ACP Skills — Source Control vs Runtime Layout

**Last Updated:** 2026-04-08  
**Purpose:** Explain where skill files live in source vs where they get deployed at runtime

---

## Repository Structure (Source Control)

```
acp-desktop/                    # ← Repository root
├── skills/                     # Production skill distribution
│   ├── README.md               # Public-facing skill documentation
│   ├── CHANGELOG.md            # Version history
│   ├── acp-skills.json         # Skill manifest
│   ├── install.ps1             # Windows installer
│   ├── install.sh              # macOS/Linux installer
│   ├── agent-onboarding/       # Universal onboarding skill
│   │   └── SKILL.md
│   ├── gitnexus-code/          # Code exploration skill
│   │   └── SKILL.md
│   └── vibe-sql/               # Database query skill
│       └── SKILL.md
├── .agents/skills/             # Claude Code CLI specific skills
│   ├── agent-startup/          # Triggered on "report as {AgentName}"
│   │   └── SKILL.md
│   └── gitnexus/               # GitNexus code intelligence suite
│       ├── gitnexus-cli/
│       ├── gitnexus-debugging/
│       ├── gitnexus-exploring/
│       ├── gitnexus-guide/
│       ├── gitnexus-impact-analysis/
│       └── gitnexus-refactoring/
├── .agents/commands/           # Claude Code slash commands (canonical source)
│   ├── agent-docs.md           # /agent-docs — agent doc lookup
│   ├── agent-mail.md           # /agent-mail — mail API reference
│   └── vibe-sql.md             # /vibe-sql — VibeSQL query helper
├── .kimi/skills/               # Kimi Code CLI specific skills
│   ├── agent-onboarding/
│   ├── gitnexus-code/
│   └── vibe-sql/
└── agent-mail-cli/             # Shared CLI tool
    └── agent-mail.js
```

---

## Runtime Deployment Layout

### End User Machines (Post-Install)

When users install ACP or run the skills installer, files land here:

#### Windows
```
%USERPROFILE%\.kimi\skills\          # Kimi skills (auto-detected)
%USERPROFILE%\.claude\skills\        # Claude skills (auto-detected)
%USERPROFILE%\.acp\bin\              # agent-mail CLI
```

#### macOS/Linux
```
~/.kimi/skills/                      # Kimi skills (auto-detected)
~/.claude/skills/                    # Claude skills (auto-detected)
~/.acp/bin/                          # agent-mail CLI
```

### Packaged App (Electron Build)

During electron-builder packaging, skills get bundled:

```
app.asar/                            # Packaged app
├── resources/
│   ├── bin/                         # Runtime binaries
│   │   ├── agent-mail.js            # Mail CLI (copied from agent-mail-cli/)
│   │   └── agent-mail.cmd           # Windows wrapper
│   └── skills/                      # Optional: bundled skills for offline install
│       └── [skill folders]
└── [app code]
```

### Development (Local ACP Running)

```
acp-desktop/                         # Dev workspace
├── resources/
│   └── bin/                         # Runtime binaries (dev)
│       ├── agent-mail.js            # Symlink or copy from agent-mail-cli/
│       └── agent-mail.cmd           # Windows wrapper
├── .kimi/skills/                    # Kimi reads these directly
├── .agents/skills/                  # Claude reads these directly
└── [source code]
```

---

## Deployment Matrix

| Source Path | Runtime Destination | Purpose | How It Gets There |
|-------------|---------------------|---------|-------------------|
| `skills/*` | `~/.kimi/skills/` or `~/.claude/skills/` | Production skill install | `install.ps1` / `install.sh` downloads from GitHub raw URLs |
| `.agents/skills/agent-startup/` | `~/.claude/skills/agent-startup/` | Claude agent initialization | Copied by ACP on first run or manual install |
| `.agents/skills/gitnexus/*` | `~/.claude/skills/gitnexus/*` | GitNexus code intelligence | Copied by ACP on first run or manual install |
| `.agents/commands/*.md` | `~/.claude/commands/*.md` (user-level) **or** `<workspace>/.claude/commands/*.md` (project-level) | Claude Code slash commands (`/agent-mail`, `/agent-docs`, `/vibe-sql`, etc.) | Copied by ACP on first run, or `install.ps1`/`install.sh`, or manually. Project-level install scopes commands to one workspace; user-level makes them global. |
| `.kimi/skills/*` | `~/.kimi/skills/` | Kimi-specific skills | Copied by ACP on first run or manual install |
| `agent-mail-cli/agent-mail.js` | `~/.acp/bin/agent-mail.js` or `resources/bin/` | Agent mail CLI | Copied at build time or by installer |

---

## Key Insight: Why This Structure?

**The `skills/` folder at repo root is the DISTRIBUTION channel.**

- It contains polished, versioned skills for public consumption
- Install scripts pull from GitHub raw URLs pointing to this folder
- Changes here affect all new installations

**The `.agents/` and `.kimi/` folders are DEVELOPMENT/LOCAL runtime.**

- These are where skills live during active development
- ACP Desktop reads from these paths directly in dev mode
- Changes here are immediate (no install step)

---

## Making Changes

### To Update Production Skills

1. Edit files in `skills/` folder
2. Update `CHANGELOG.md` with version bump
3. Commit and push
4. New installs get the updated version automatically

### To Update Development Skills

1. Edit files in `.kimi/skills/` or `.agents/skills/`
2. Test immediately (no build step)
3. When ready, sync to `skills/` for distribution

### To Add a New Skill

1. Create skill folder in both locations:
   - `skills/my-skill/SKILL.md` (distribution)
   - `.kimi/skills/my-skill/SKILL.md` (dev runtime)
   - `.agents/skills/my-skill/SKILL.md` (if Claude-specific)
2. Update `skills/acp-skills.json` manifest
3. Update install scripts if needed
4. Update this DEPLOYMENT.md

---

## Critical Files Checklist

These files MUST be in source control:

- [ ] `skills/README.md` — Public documentation
- [ ] `skills/CHANGELOG.md` — Version history
- [ ] `skills/acp-skills.json` — Skill manifest
- [ ] `skills/install.ps1` — Windows installer
- [ ] `skills/install.sh` — macOS/Linux installer
- [ ] `skills/*/SKILL.md` — Each skill definition
- [ ] `.agents/skills/agent-startup/SKILL.md` — Claude startup (critical!)
- [ ] `.agents/skills/gitnexus/*/SKILL.md` — GitNexus suite
- [ ] `.kimi/skills/*/SKILL.md` — Kimi skills

---

## Troubleshooting

### Skills Not Loading in Dev

Check that skills are in the right place:
```bash
# For Kimi
ls ~/.kimi/skills/

# For Claude
ls ~/.claude/skills/
```

### Skills Out of Sync Between Repos

Run this to sync stable → desktop:
```bash
cd acp-desktop
git checkout stable/master -- skills/ .agents/skills/agent-startup/
git commit -m "sync: Update skills from stable"
```

### Install Script Failing

Verify the raw GitHub URL is correct:
```
https://raw.githubusercontent.com/PayEz-Net/acp/main/skills/install.ps1
```

---

**Remember:** The database (`vibe.global_vibe_agents`) is the source of truth for agent personas. These skills only handle the *triggering* and *context loading* — the actual agent identity lives in VibeSQL.
