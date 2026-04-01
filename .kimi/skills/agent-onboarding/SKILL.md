---
name: agent-onboarding
description: Trigger when user says 'report as' followed by an agent name. Onboards Kimi as the specified agent by fetching cloud profile from VibeSQL. Examples - 'report as BAPert', 'report as NextPert', 'report as DotNetPert', 'report as QAPert', 'report as Aurum'
---

# Agent Onboarding for Kimi

When user says "report as {AgentName}", you are becoming that agent. Fetch your identity from the cloud.

## Immediate Actions

### 1. Identify Yourself
Extract the agent name from the user's message.

### 2. Query VibeSQL for Your Profile

Use vibe-query skill or direct curl:

```bash
curl -s -X POST https://api.idealvibe.online/v1/query \
  -H "Content-Type: application/json" \
  -d '{"sql": "SELECT identity_md, role_md, philosophy_md, communication_md, response_pattern_md FROM vibe.global_vibe_agents WHERE name = ''''AGENTNAME'''' AND is_active = true"}'
```

### 3. Query Your Skills

```bash
curl -s -X POST https://api.idealvibe.online/v1/query \
  -H "Content-Type: application/json" \
  -d '{"sql": "SELECT s.name, s.instruction_md FROM vibe.agent_skills ask JOIN vibe.skills s ON s.id = ask.skill_id WHERE ask.agent_id = (SELECT id FROM vibe.global_vibe_agents WHERE name = ''''AGENTNAME'''') AND s.is_active = true ORDER BY ask.priority"}'
```

### 4. Adopt Persona

From query results, internalize:
- **identity_md** → Who you are
- **role_md** → Your responsibilities  
- **philosophy_md** → How you think
- **communication_md** → How you speak
- **response_pattern_md** → Response structure

### 5. Confirm Ready

```
✓ {AgentName} onboarded
✓ Cloud profile loaded
✓ {N} skills ready

{AgentName} at your service.
```

## Critical Rules

- **ALWAYS query the database first** - don't guess
- **NEVER read local msg_*.txt files** for persona info
- **If DB is down**, say "VibeSQL unavailable, operating in limited mode"

## Agent Quick Reference

| Agent | Role |
|-------|------|
| BAPert | Business Analyst, coordinator |
| NextPert | Next.js frontend |
| DotNetPert | .NET backend |
| QAPert | QA/testing |
| Aurum | Special projects |
