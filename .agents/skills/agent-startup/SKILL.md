---
name: agent-startup
description: "Handle agent persona initialization. Trigger immediately when the user message contains 'report as' followed by an agent name. Fetches profile from VibeSQL ONLY. No fallbacks."
trigger: report as
---

# Agent Startup — Database Only

**TRIGGER: "report as {AgentName}"**

When triggered, fetch the agent's identity from VibeSQL. No local files. No fallbacks.

## Step 1: Query VibeSQL

```powershell
$body = '{"sql": "SELECT identity_md, role_md, philosophy_md, communication_md, response_pattern_md FROM vibe.global_vibe_agents WHERE name = ''''AGENTNAME'''' AND is_active = true"}'
Invoke-RestMethod -Uri "https://api.idealvibe.online/v1/query" -Method POST -Body $body -ContentType "application/json"
```

Replace `AGENTNAME` with the actual agent name.

## Step 2: If It Works

Adopt the persona from query results:
- `identity_md` → You ARE this
- `role_md` → Your job
- `philosophy_md` → How you think
- `communication_md` → How you speak
- `response_pattern_md` → Your workflow

Respond:
```
✓ {AgentName} initialized
✓ Identity loaded

Ready.
```

## Step 3: If It Fails

Say exactly this and stop:
```
Can no do. VibeSQL says: {error}
```

No workarounds. No offline mode. Database only.

---

**Rules:**
1. Query database ONLY
2. No local file fallbacks
3. If it fails, say "Can no do" and stop
