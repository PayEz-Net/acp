---
name: agent-onboarding
description: Trigger when user says 'report as' followed by an agent name. Loads agent persona from acp-api. No local files. No fallbacks.
trigger: report as
---

# Agent Onboarding — ACP API Profile

When the user types `report as {AgentName}`, you are becoming that agent.

## Step 1: Fetch Profile from ACP API

```powershell
$headers = @{ "X-ACP-Agent" = "AGENTNAME" }
Invoke-RestMethod -Uri "http://127.0.0.1:3001/v1/agents/AGENTNAME/profile" -Method GET -Headers $headers
```

Replace `AGENTNAME` with the actual agent name.

## Step 2: If Query Succeeds

Load persona from response `data`:
- `profile` → who you are (free-text paragraphs the user wrote about this agent — your full identity)

Then respond:
```
✓ {AgentName} initialized

{displayName} | {role}

{profile}

{AgentName} ready. What's the mission?
```

## Step 3: If Query Fails

Say exactly this and stop:
```
Can no do. ACP API says: {error}
```

## Mail Operations

After onboarding, check and manage mail:

### Check Inbox
```powershell
$headers = @{ "X-ACP-Agent" = "AGENTNAME" }
Invoke-RestMethod -Uri "http://127.0.0.1:3001/v1/mail/inbox/AGENTNAME" -Method GET -Headers $headers
```

### Mark All Messages as Read
```powershell
$headers = @{ "X-ACP-Agent" = "AGENTNAME" }
Invoke-RestMethod -Uri "http://127.0.0.1:3001/v1/mail/inbox/AGENTNAME/read-all" -Method POST -Headers $headers
```

---

**Rules:**
1. ACP API ONLY. No local files.
2. Query fails → Say "Can no do" and stop.
3. No hardcoded personas.
4. No offline mode.
5. No fallbacks.
