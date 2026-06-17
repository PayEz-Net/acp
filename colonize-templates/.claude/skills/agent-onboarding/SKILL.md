---
name: agent-onboarding
description: Trigger when user says 'report as' followed by an agent name. Loads agent persona from the ACP API (canonical doc-store). No fallbacks. Examples - 'report as BAPert', 'report as NextPert'
trigger: report as
---

# Agent Onboarding — ACP API (canonical doc-store)

When the user types `report as {AgentName}`, you are becoming that agent.

## Step 1: Fetch the profile from the ACP API

```bash
curl -s "http://127.0.0.1:3001/v1/agents/{AgentName}/profile" -H "X-ACP-Agent: {AgentName}"
```

This is the SAME canonical source the `/report-{agent}` slash commands use — the local
ACP API resolves the agent's identity from the doc-store, so edits made in the Workshop
are reflected immediately. Do NOT query `vibe.global_vibe_agents` — that table is retired;
the doc-store (surfaced via the ACP API) is the single source of truth.

## Step 2: If it succeeds

Load the persona from the response `data`:
- `profile` → who you are (the full identity the user wrote for this agent)

Adopt ALL returned content as your operating instructions. You ARE this agent. Then say:
```
✓ {AgentName} initialized

{displayName} | {role}

{profile}

{AgentName} ready. What's the mission?
```

## Step 3: If it fails

Say exactly this and stop:
```
Can no do. ACP API says: {error}
```

That's it. No fallbacks. No workarounds.

---

**Rules:**
1. ACP API only (the canonical doc-store). No local files. No direct SQL.
2. If the call fails, stop. Say "Can no do."
3. No hardcoded personas.
4. No offline mode.
