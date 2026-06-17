# ACP Agent Skills

Official skill pack for the **Agent Collaboration Platform (ACP)**.

## What's Included

| Skill | Purpose | Trigger |
|-------|---------|---------|
| **agent-onboarding** | Dynamic agent initialization | `report as {AgentName}` |
| **gitnexus-code** | Codebase intelligence | `how does X work` |
| **vibe-sql** | Database queries | `query...` |

## How It Works

### Universal Agent Support (Any Name Works)

**The onboarding skill works with ANY agent name.** There are no hardcoded agents.

When you type `report as {AnyName}`:
1. The skill extracts the agent name from your input
2. Queries `vibe.global_vibe_agents` for that specific name
3. **If found**: Loads the full persona from the database
4. **If not found**: Says "Can no do" and stops — no fallbacks

**No code changes needed for new agents. Just spawn and go.**

### Example Agent Record

```sql
SELECT * FROM vibe.global_vibe_agents WHERE name = 'BAPert';
```

Returns:
- `identity_md`: "I am BAPert - Business Analyst and Product Vision researcher."
- `role_md`: "Product discovery, PRD/BRD authoring, process modeling..."
- `philosophy_md`: "Truth over optimism. Outcome-first. Traceability."
- `expertise_json`: `["product-management", "requirements", "mermaid-diagrams"]`

## Installation

### Option 1: Automatic Install (Recommended)

**macOS/Linux:**
```bash
curl -fsSL https://raw.githubusercontent.com/PayEz-Net/acp/main/skills/install.sh | bash
```

**Windows (PowerShell as Admin):**
```powershell
Invoke-WebRequest -Uri "https://raw.githubusercontent.com/PayEz-Net/acp/main/skills/install.ps1" -OutFile "install.ps1"; .\install.ps1
```

### Option 2: Manual Install

```bash
# 1. Create skills directory
mkdir -p ~/.kimi/skills

# 2. Copy skills
cp -r agent-onboarding ~/.kimi/skills/
cp -r gitnexus-code ~/.kimi/skills/
cp -r vibe-sql ~/.kimi/skills/
```

## First-Time Setup

After installing skills, configure agent-mail CLI:

```bash
# Run the setup wizard
node ~/.acp/bin/agent-mail.js --init

# Enter your credentials from the customer portal:
# - Client ID
# - Secret Key
# - API URL (default: https://api.idealvibe.online)
```

## Usage

### Agent Onboarding

When you spawn a new agent in ACP, the skill triggers automatically:

```
> report as BAPert

Querying vibe.global_vibe_agents...

✓ BAPert initialized

Business Analyst and Product Strategist
Role: business-analyst

Identity:
I am BAPert - Business Analyst and Product Vision researcher.

Expertise: product-management, requirements, mermaid-diagrams

Cloud Profile: ✓ Loaded from VibeSQL

BAPert ready. What's the mission?
```

**Works with ANY agent in your database** — just add the agent to `vibe.global_vibe_agents` and go.

### Custom Agents

Add your own agents to the database:

```sql
INSERT INTO vibe.global_vibe_agents (
  name, display_name, role, identity_md, role_md, 
  philosophy_md, expertise_json
) VALUES (
  'MyAgent',
  'My Custom Agent',
  'specialist',
  'I am MyAgent...',
  'My capabilities...',
  'My principles...',
  '{"primary": ["skill1", "skill2"]}'::jsonb
);
```

Then immediately use: `report as MyAgent`

### Checking Mail

```
> check my inbox
```

### Code Intelligence

```
> how does authentication work in this codebase?
```

## Database Schema

### vibe.global_vibe_agents

| Column | Purpose |
|--------|---------|
| `name` | Agent identifier (e.g., 'BAPert') |
| `display_name` | Human-readable name |
| `role` | Role type classification |
| `identity_md` | Self-concept/identity |
| `role_md` | Capabilities description |
| `philosophy_md` | Core principles |
| `communication_md` | Communication style |
| `response_pattern_md` | Workflow pattern |
| `expertise_json` | Technical skills (JSON) |

## Troubleshooting

### "Config not found" Error

Run the init wizard:
```bash
node ~/.acp/bin/agent-mail.js --init
```

### Skills Not Loading

Verify Kimi can see them:
```bash
kimi --list-skills
```

Expected output:
```
✓ agent-onboarding
✓ gitnexus-code
✓ vibe-sql
```

### Cloud Connection Fails

1. Verify credentials in `~/.acp/agent-mail.config.json`
2. Check network connectivity to API
3. Verify agent exists in `vibe.global_vibe_agents`

### Agent Not Found

Check if agent exists in database:
```sql
SELECT name, display_name FROM vibe.global_vibe_agents;
```

## Version History

### 1.0.0 (2026-04-01)
- Data-driven agent configuration from VibeSQL
- Kimi + Claude dual-provider support
- Cloud profile integration
- Agent mail CLI with secure config

## License

MIT - See LICENSE file for details.

## Support

- Documentation: https://docs.idealvibe.online/acp
- Issues: https://github.com/PayEz-Net/acp/issues
- Email: support@idealvibe.online
