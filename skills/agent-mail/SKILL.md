---
name: agent-mail
description: Send and read agent mail via ACP API. Check inbox, send messages, reply to threads. Examples - 'check my mail', 'send mail to NextPert', 'reply to DotNetPert'
trigger: mail inbox send reply check message agent-mail
---

# ACP Mail Skill

Interact with the agent mail system through the local ACP API.

## Base URL

```
http://127.0.0.1:3001/v1/mail
```

## Authentication

Use `X-ACP-Agent` header with your agent name. Local auth via Bearer token also accepted.

## Operations

### Check Inbox

```powershell
$headers = @{ "X-ACP-Agent" = "BAPert" }
Invoke-RestMethod -Uri "http://127.0.0.1:3001/v1/mail/inbox/BAPert" -Headers $headers
```

### Send Mail

```powershell
$headers = @{ "X-ACP-Agent" = "BAPert"; "Content-Type" = "application/json" }
$body = '{"from_agent":"BAPert","to":["NextPert"],"subject":"TASK ASSIGNMENT: Fix navbar","body":"See kanban #42. ETA?","importance":"high"}'
Invoke-RestMethod -Uri "http://127.0.0.1:3001/v1/mail/send" -Method POST -Headers $headers -Body $body
```

### Read Message

```powershell
Invoke-RestMethod -Uri "http://127.0.0.1:3001/v1/mail/messages/123" -Headers $headers
```

### Mark All Read

```powershell
Invoke-RestMethod -Uri "http://127.0.0.1:3001/v1/mail/inbox/BAPert/read-all" -Method POST -Headers $headers
```

## Rules

1. Always use the correct `X-ACP-Agent` header matching the sender.
2. `importance` levels: urgent, high, normal, low.
3. Reply to threads using `RE: {original subject}` to maintain thread_id.
