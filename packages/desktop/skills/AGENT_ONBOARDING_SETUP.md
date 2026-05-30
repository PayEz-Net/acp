# Agent Onboarding Setup Guide

**Purpose:** Step-by-step guide for setting up agent onboarding in new ACP installations  
**Applies to:** Fresh installs, new developer setups, CI/CD deployments  
**Last Updated:** 2026-04-08

---

## Overview

Agent onboarding transforms a generic AI assistant into a specialized agent persona using **streaming markdown from the database**. No local files. No hardcoded personas. Just database-driven identity.

When a user types `report as BAPert`, the system:
1. Queries `vibe.global_vibe_agents` for that agent's profile
2. Streams the markdown fields (`identity_md`, `role_md`, etc.) into context
3. The AI adopts that persona immediately

---

## Prerequisites

- [ ] ACP Desktop or ACP Stable cloned
- [ ] Kimi Code CLI or Claude Code CLI installed
- [ ] Access to VibeSQL API (`https://api.idealvibe.online` or local)
- [ ] Agent records in `vibe.global_vibe_agents` table

---

## Installation

### Step 1: Install Skills

**Option A: Automatic (Recommended)**

```powershell
# Windows (PowerShell as Admin)
Invoke-WebRequest -Uri "https://raw.githubusercontent.com/PayEz-Net/acp/main/skills/install.ps1" -OutFile "install.ps1"; .\install.ps1
```

```bash
# macOS/Linux
curl -fsSL https://raw.githubusercontent.com/PayEz-Net/acp/main/skills/install.sh | bash
```

**Option B: Manual Copy (Development)**

For Kimi Code CLI:
```powershell
# Windows
New-Item -ItemType Directory -Force -Path "$env:USERPROFILE\.kimi\skills\agent-onboarding"
Copy-Item "skills\agent-onboarding\SKILL.md" "$env:USERPROFILE\.kimi\skills\agent-onboarding\"

# Verify
kimi --list-skills
```

For Claude Code CLI:
```powershell
# Windows
New-Item -ItemType Directory -Force -Path "$env:USERPROFILE\.claude\skills\agent-startup"
Copy-Item ".agents\skills\agent-startup\SKILL.md" "$env:USERPROFILE\.claude\skills\agent-startup\"

# Verify
claude --list-skills
```

---

### Step 2: Configure Agent Database

**You MUST have agents in `vibe.global_vibe_agents` before onboarding works.**

#### Check Existing Agents

```sql
SELECT name, display_name, role, is_active 
FROM vibe.global_vibe_agents 
WHERE is_active = true;
```

#### Add a New Agent

```sql
INSERT INTO vibe.global_vibe_agents (
  name,                    -- Unique identifier (e.g., 'BAPert')
  display_name,            -- Human-readable (e.g., 'BAPert — Business Analyst')
  role,                    -- Short role (e.g., 'business-analyst')
  identity_md,             -- Who they are (markdown)
  role_md,                 -- What they do (markdown)
  philosophy_md,           -- How they think (markdown)
  communication_md,        -- How they speak (markdown)
  response_pattern_md,     -- Workflow pattern (markdown)
  expertise_json,          -- Skills as JSON
  is_active                -- Must be true
) VALUES (
  'MyAgent',
  'MyAgent — Custom Specialist',
  'specialist',
  'I am MyAgent, a specialist in...',
  'My role is to...',
  'I believe in...',
  'I communicate clearly and...',
  'When given a task, I...',
  '{"primary": ["skill1", "skill2"], "secondary": ["skill3"]}',
  true
);
```

---

### Step 3: Test Onboarding

Open your AI CLI and type:

```
report as BAPert
```

**Expected Success:**
```
✓ BAPert initialized

BAPert — Business Analyst | business-analyst

I am BAPert, bridging business needs and technical implementation...

BAPert ready. What's the mission?
```

**Expected Failure (agent not in DB):**
```
Can no do. VibeSQL says: Agent not found
```

**Expected Failure (API down):**
```
Can no do. VibeSQL says: Connection refused
```

---

## Database Schema Reference

### vibe.global_vibe_agents

| Column | Type | Purpose | Example |
|--------|------|---------|---------|
| `name` | varchar(50) PK | Unique agent ID | 'BAPert' |
| `display_name` | varchar(100) | Human name | 'BAPert — Business Analyst' |
| `role` | varchar(50) | Role type | 'business-analyst' |
| `identity_md` | text | **Streaming:** Self-concept | 'I am BAPert...' |
| `role_md` | text | **Streaming:** Capabilities | 'I gather requirements...' |
| `philosophy_md` | text | **Streaming:** Principles | 'Truth over optimism...' |
| `communication_md` | text | **Streaming:** Voice | 'Clear, organized...' |
| `response_pattern_md` | text | **Streaming:** Workflow | 'When given X, I do Y...' |
| `expertise_json` | jsonb | Skills list | '["sql", "requirements"]' |
| `is_active` | boolean | Enable/disable | true |
| `created_at` | timestamp | Record creation | auto |
| `updated_at` | timestamp | Last update | auto |

**Important:** The `_md` suffix fields contain **streaming markdown** that gets injected into the AI's context window when onboarding triggers.

---

## File Locations (Critical)

### Source Control (This Repo)

```
acp-stable/
├── .kimi/skills/agent-onboarding/SKILL.md      ← Kimi version
├── .agents/skills/agent-startup/SKILL.md       ← Claude version
└── skills/agent-onboarding/SKILL.md            ← Distribution copy
```

### Runtime (User Machine)

```
%USERPROFILE%/.kimi/skills/agent-onboarding/SKILL.md     ← Kimi reads this
%USERPROFILE%/.claude/skills/agent-startup/SKILL.md      ← Claude reads this
```

### ACP Desktop Dev Mode

ACP Desktop in dev mode reads directly from the repo:
```
acp-stable/.kimi/skills/        ← Kimi uses these directly in dev
acp-stable/.agents/skills/      ← Claude uses these directly in dev
```

---

## How It Works (Flow Diagram)

```
User types: "report as BAPert"
         │
         ▼
┌─────────────────────────────────┐
│  Skill Triggered (SKILL.md)     │
│  - Extracts "BAPert"            │
└─────────────────────────────────┘
         │
         ▼
┌─────────────────────────────────┐
│  Query VibeSQL                  │
│  SELECT * FROM vibe.global_     │
│    vibe_agents WHERE name=      │
│    'BAPert'                     │
└─────────────────────────────────┘
         │
    ┌────┴────┐
    │         │
 Success   Failure
    │         │
    ▼         ▼
┌────────┐  ┌──────────────┐
│Stream  │  │Say:          │
│markdown│  │"Can no do.   │
│fields  │  │VibeSQL says" │
│to AI   │  │              │
└────────┘  └──────────────┘
    │
    ▼
┌─────────────────────────────────┐
│  AI Adopts Persona              │
│  - identity_md → self-concept   │
│  - role_md → capabilities       │
│  - philosophy_md → thinking     │
│  - etc.                         │
└─────────────────────────────────┘
         │
         ▼
    "BAPert ready. 
     What's the mission?"
```

---

## Troubleshooting

### "Can no do. VibeSQL says: ..."

| Error | Cause | Fix |
|-------|-------|-----|
| `Agent not found` | Agent not in DB | Add to `vibe.global_vibe_agents` |
| `Connection refused` | API is down | Check `api.idealvibe.online` status |
| `Unauthorized` | Bad credentials | Check `~/.acp/agent-mail.config.json` |
| `Table not found` | Schema issue | Run migrations |

### Skill Not Triggering

```bash
# Check skill is installed
kimi --list-skills

# Expected: ✓ agent-onboarding

# If missing, reinstall:
cp -r acp-stable/.kimi/skills/agent-onboarding ~/.kimi/skills/
```

### Skill Still Using Old Logic

Skills are cached. Restart your AI CLI:
```bash
# Exit and reopen
kimi
```

### Database Schema Mismatch

Check your table matches expected schema:
```sql
-- Verify columns exist
SELECT column_name, data_type 
FROM information_schema.columns 
WHERE table_name = 'global_vibe_agents' 
  AND table_schema = 'vibe';
```

Expected columns: `name`, `display_name`, `role`, `identity_md`, `role_md`, `philosophy_md`, `communication_md`, `response_pattern_md`, `expertise_json`, `is_active`

---

## Adding New Agents (Template)

Copy-paste template for new agents:

```sql
INSERT INTO vibe.global_vibe_agents (
  name, display_name, role,
  identity_md, role_md, philosophy_md,
  communication_md, response_pattern_md,
  expertise_json, is_active
) VALUES (
  'AgentName',
  'AgentName — Role Title',
  'role-slug',
  E'I am AgentName, [self-concept].\n\n[I do X, Y, Z].',
  E'My role is to [specific capabilities].\n\n[I excel at X].',
  E'[Core principle 1].\n[Core principle 2].\n[Core principle 3].',
  E'I communicate [style].\n\nI [specific communication traits].',
  E'When given a task:\n1. [Step one]\n2. [Step two]\n3. [Step three]',
  '{"primary": ["skill1", "skill2"], "secondary": ["skill3"]}',
  true
);
```

**Tips:**
- Use `E'...'` syntax for multi-line text in PostgreSQL
- Write `identity_md` in first person ("I am...")
- `expertise_json` must be valid JSON
- Keep markdown concise but expressive

---

## Development Workflow

### Modifying Onboarding Logic

1. **Edit** the skill in `acp-stable/.kimi/skills/agent-onboarding/SKILL.md`
2. **Test** immediately with `kimi` (no build step)
3. **Sync** to distribution copy: `cp .kimi/skills/agent-onboarding/SKILL.md skills/agent-onboarding/`
4. **Commit** both changes
5. **Backstream** to acp-desktop if needed

### Adding a New Skill

1. Create folder in all three locations:
   - `.kimi/skills/my-skill/SKILL.md`
   - `.agents/skills/my-skill/SKILL.md` (if Claude needs it)
   - `skills/my-skill/SKILL.md` (distribution)
2. Update `skills/acp-skills.json`
3. Update `skills/README.md`
4. Update this guide

---

## Environment Variables

These are set by ACP Desktop when spawning agents:

| Variable | Purpose | Example |
|----------|---------|---------|
| `ACP_API_URL` | API endpoint | `http://localhost:3001` |
| `ACP_BIN_DIR` | CLI location | `C:\Program Files\ACP\resources\bin` |
| `VIBE_AGENT` | Agent name | `BAPert` |
| `ACP_AGENT_ID` | Full ID | `agent:BAPert` |

---

## Security Notes

- **No secrets in skills** — Skills are plain text, never store API keys
- **Database is source of truth** — All personas live in VibeSQL
- **No local fallbacks** — Can't spoof personas with local files
- **HTTPS only** — Production API requires TLS

---

## Quick Reference Card

```
INSTALL
  Windows: irm https://.../install.ps1 | iex
  Linux:   curl .../install.sh | bash

TEST
  report as BAPert

DEBUG
  Check DB: SELECT * FROM vibe.global_vibe_agents WHERE name = 'BAPert';
  Check skill: kimi --list-skills

ADD AGENT
  INSERT INTO vibe.global_vibe_agents (...)

FAILURE
  "Can no do. VibeSQL says: {error}"
```

---

## See Also

- `DEPLOYMENT.md` — Source control vs runtime layout
- `README.md` — Public-facing skill documentation
- `CHANGELOG.md` — Version history
- Database schema: `vibe.global_vibe_agents`

---

**Remember:** The database is the ONLY source of truth. No local files. No fallbacks. Works or "can no do."
