# Agent Mail

You are an AI agent with access to the agent mail system via the ACP API. Use this to check your inbox, read messages, and send mail to other agents.

## Your Identity

You were assigned an agent name when you started (e.g. "report as DotNetPert"). Use that name for all mail operations.

## API Access

**Base URL:** `http://127.0.0.1:3001/v1/mail`

**Required header on ALL requests:**
```
X-ACP-Agent: {YOUR_AGENT_NAME}
```

That's it. One header. The ACP API handles auth.

---

## Inbox

### Check Inbox (UNREAD ONLY — use this on startup)
```bash
curl -s "http://127.0.0.1:3001/v1/mail/inbox/{YOUR_AGENT_NAME}?unread=true" \
  -H "X-ACP-Agent: {YOUR_AGENT_NAME}"
```

### Check Inbox (all messages)
```bash
curl -s "http://127.0.0.1:3001/v1/mail/inbox/{YOUR_AGENT_NAME}" \
  -H "X-ACP-Agent: {YOUR_AGENT_NAME}"
```

### Inbox Query Parameters
| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `unread` | bool | `false` | **Set to `true` to get only unread messages** |
| `importance` | string | — | Filter by importance: `normal`, `high` |
| `page` | int | `1` | Page number |
| `pageSize` | int | `20` | Results per page (max 100) |

---

## Messages

### Read a Message
```bash
curl -s "http://127.0.0.1:3001/v1/mail/messages/{MESSAGE_ID}" \
  -H "X-ACP-Agent: {YOUR_AGENT_NAME}"
```

### Send Mail
```bash
curl -s -X POST "http://127.0.0.1:3001/v1/mail/send" \
  -H "X-ACP-Agent: {YOUR_AGENT_NAME}" \
  -H "Content-Type: application/json" \
  -d '{
    "from_agent": "{YOUR_AGENT_NAME}",
    "to": ["{RECIPIENT_AGENT_NAME}"],
    "subject": "Subject here",
    "body": "Message body here",
    "importance": "normal"
  }'
```
Body limit: 65KB. Use `"importance": "high"` for blockers or urgent items.

---

## Read Status

### Mark ALL Messages as Read
```bash
curl -s -X POST "http://127.0.0.1:3001/v1/mail/inbox/{YOUR_AGENT_NAME}/read-all" \
  -H "X-ACP-Agent: {YOUR_AGENT_NAME}"
```

---

## Available Agents

| Name | Role |
|------|------|
| BAPert | Business Analyst / Team Lead |
| DotNetPert | .NET Backend Specialist |
| NextPert | Next.js Frontend Specialist |
| QAPert | QA Analyst |
| Aurum | Platform Architect |

---

## Startup Behavior

1. Run `/agent-mail` to load this skill
2. **Check unread inbox: `?unread=true`** (not the full inbox)
3. Process actionable messages
4. Report completion back to sender via mail
5. Leave messages unread during your session (unread = current session trail)
