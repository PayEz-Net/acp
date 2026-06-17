---
name: vibe-sql
description: Query VibeSQL PostgreSQL databases. Use for reading agent profiles, checking mail, inspecting schemas. Data-driven agent configuration lives in vibe.global_vibe_agents table.
triggers: ["query", "check inbox", "show agents", "list tables", "describe"]
---

# VibeSQL Query Skill for Kimi

Query VibeSQL databases via ACP-API.

## Mail API (Cloud Proxy - Real-time)

**Use `/v1/mail/*` for real-time mail (cloud proxy, no cache lag)**

### Check Inbox (Fresh from cloud)
```bash
# All messages (sorted: unread first, then newest - "newest unread")
curl.exe -s -H "X-ACP-Agent: YourAgentName" http://127.0.0.1:3001/v1/mail/inbox/YourAgentName

# Unread only (accurate count)
curl.exe -s -H "X-ACP-Agent: YourAgentName" "http://127.0.0.1:3001/v1/mail/inbox/YourAgentName?unread=true"
```

**Sorting options:**
- `?sort=newest-unread` (default) - Unread messages first, then by date
- `?sort=newest` - By date only, regardless of read status

Examples:
```bash
# Newest unread first (default)
curl.exe -s -H "X-ACP-Agent: BAPert" "http://127.0.0.1:3001/v1/mail/inbox/BAPert"

# Just newest, mixing read and unread
curl.exe -s -H "X-ACP-Agent: BAPert" "http://127.0.0.1:3001/v1/mail/inbox/BAPert?sort=newest"

# Unread only, sorted newest first
curl.exe -s -H "X-ACP-Agent: BAPert" "http://127.0.0.1:3001/v1/mail/inbox/BAPert?unread=true&sort=newest"
```

### Send Mail
```bash
curl.exe -s -X POST http://127.0.0.1:3001/v1/mail/send `
  -H "Content-Type: application/json" `
  -H "X-ACP-Agent: YourAgentName" `
  -d "{\"from_agent\": \"YourAgentName\", \"to\": [\"TargetAgent\"], \"subject\": \"Subject\", \"body\": \"Message body\"}"
```

### Mark Message as Read
```bash
curl.exe -s -X POST http://127.0.0.1:3001/v1/mail/inbox/{messageId}/read `
  -H "X-ACP-Agent: YourAgentName"
```

### Mark All Messages as Read
```bash
curl.exe -s -X PUT http://127.0.0.1:3001/v1/messages/inbox/{agentName}/read `
  -H "X-ACP-Agent: YourAgentName"
```

### Get Unread Count (PowerShell)
```powershell
$response = curl.exe -s -H "X-ACP-Agent: YourAgentName" http://127.0.0.1:3001/v1/messages/inbox/YourAgentName | ConvertFrom-Json
$unread = $response.data.messages | Where-Object { !$_.isRead }
Write-Host "Unread: $($unread.Count)"
```

### Using Node.js (Most Reliable)
```javascript
fetch('http://127.0.0.1:3001/v1/mail/inbox/YourAgentName?unread=true', {
  headers: { 'X-ACP-Agent': 'YourAgentName' }
}).then(r => r.json()).then(data => {
  const msgs = data.data?.messages || [];
  const unread = msgs.filter(m => !m.isRead);
  console.log(`Total: ${msgs.length}, Unread: ${unread.length}`);
});
```

## Agent Profile Loading (for "report as")

Personas load from the ACP API — **server-side only, no local files, no fallback** (matches the `agent-onboarding` skill):

```bash
curl.exe -s -H "X-ACP-Agent: YourAgentName" http://127.0.0.1:3001/v1/agents/YourAgentName/profile
```

Read your identity from the response `data.profile` (the free-text persona the user wrote about this agent). **If the query fails, say so and stop — do NOT fall back to a local file or a generic persona.** The legacy `strike-team/*.md` local files are not a source of truth.

## agent-mail CLI

The `agent-mail` command is available in agent PTYs:

```bash
# Check inbox
agent-mail --agent BAPert inbox

# Send message
agent-mail --agent BAPert send NextPert "Subject" --body "Message"
```

## Direct VibeSQL Query (via api.idealvibe.online)

For direct SQL queries to the cloud VibeSQL:

```bash
curl -s -X POST https://api.idealvibe.online/v1/query \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -d '{"sql": "SELECT * FROM vibe.global_vibe_agents WHERE name = '\''BAPert'\''"}'
```

## Common Queries

### List All Agents
```sql
SELECT name, display_name, role FROM vibe.global_vibe_agents ORDER BY name
```

### Check Mail
```sql
SELECT message_id, from_agent, subject, created_at 
FROM vibe.agent_mail 
WHERE to_agent = 'YourAgentName' AND read_at IS NULL
ORDER BY created_at DESC
```

### List Tables
```sql
SELECT table_name FROM information_schema.tables 
WHERE table_schema = 'vibe' ORDER BY table_name
```
