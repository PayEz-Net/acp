---
name: agent-mail
description: Send and read agent mail via ACP API. Check inbox, send messages, reply to threads. Examples - 'check my mail', 'send mail to NextPert', 'reply to DotNetPert'
trigger: mail inbox send reply check message agent-mail
---

# ACP Mail Skill

Interact with the agent mail system through the local ACP API.

## Mail discipline (Mail Muffler -- team norm)

GLANCE, DON'T ACK. Receiving mail, your default is: read the title, comply or
absorb, and send NOTHING. A reply is the exception.

Reply ONLY if your message has at least one of:
  1. New information the recipients don't have.
  2. An answer to a direct question asked of you.
  3. A real blocker (you can't proceed -- say why).
  4. A correction that changes what someone will do.
  5. A disagreement (silence = agreement, so you MUST speak to object).

NEVER send: "agreed / noted / ACK / concur / locked / will do / got it / thanks /
confirmed / looks good / +1", restating a ruling back, "converged / closing /
crossed in flight", or morale acks. Glancing IS the receipt.

A lead's ruling: if you agree, comply SILENTLY -- the work is the proof. Report a
completion later only if its result isn't otherwise visible, and send it as Info.

INFO TIER: send purely informational mail (status / FYI / "done" / "ready") at
importance "info" (lowercase, terminal). The SUBJECT IS THE WHOLE MESSAGE -- write it
complete and self-sufficient (NOT "FYI build done" with the what/where left in a body
nobody reads); body is optional, omit it. An info mail arrives ALREADY READ (never
bumps the unread count), stays findable in the full inbox, and is NEVER acked or
replied to. Use info ONLY when the recipient needs to do nothing. Anything needing a
read or reply is "normal" or higher.

Send-syntax -- POST /v1/mail/send:
  { "from_agent": "YourName", "to": ["Recipient"],
    "subject": "<the whole message, written complete>", "importance": "info" }

If you need confirmation that a directive landed, ASK a direct question -- don't
expect an unsolicited ack.

IRREVERSIBLE GATES are the one carve-out. ANY actor may raise the gate flag on a
destructive/irreversible action (do NOT fire / promote / wipe) -- not just the lead,
and you may self-flag your own pending action ("this is irreversible, holding for
explicit go"). On a flagged gate, silence != proceed. Two cases:
  - Lead flags a HOLD: each addressed (TO) actor replies one word, "held", to the
    flagger. The action is held until EVERY TO-recipient has replied "held".
  - You self-flag your own action: hold until the lead's explicit "go".
Unconfirmed = do NOT proceed. This is the ONLY time a confirm is required. Keep
gate-flags rare (judgment, not restricted to the lead).

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
