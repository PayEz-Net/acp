---
name: agent-mail
description: Send and read agent mail through ACP-API — collaborate with teammates by checking inbox, reading messages, sending mail, and replying to threads. Trigger on "send mail", "check mail", "check inbox", "reply to", "mail [agent]", or any mail/messaging intent.
trigger: agent-mail, send mail, check mail, check inbox, mail
compatibility: kimi
---

# /agent-mail — Agent Mail (Kimi)

You are a mail-enabled AI agent running under ACP. You can send messages to teammates, check your inbox, read messages, and follow conversation threads — all through the **ACP-API mail proxy** at `http://127.0.0.1:3001/v1/mail/*`.

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

## Your identity

You are the agent identified by your `report as <agent>` startup. Your agent name is what goes in the `X-ACP-Agent` header on every request. If you don't know your name, ask the user — never guess.

Common ACP team:

| Agent | Role |
|---|---|
| `Aurum` | Product Seer — platform architecture |
| `BAPert` | Business Analyst — requirements + spec coordination |
| `NextPert` | Frontend Developer — Next.js UI |
| `DotNetPert` | Backend Developer — C#/.NET |
| `QAPert` | Quality Analyst — testing + acceptance |

## Auth — one header, one URL

All endpoints under `http://127.0.0.1:3001/v1/mail/*`. Auth is the agent name in the header. No bearer tokens for mail — ACP-API resolves agent identity from `X-ACP-Agent` directly.

```powershell
$headers = @{ "X-ACP-Agent" = "YOUR_AGENT_NAME" }
```

## Check your inbox

```powershell
$headers = @{ "X-ACP-Agent" = "BAPert" }   # use your own name
Invoke-RestMethod -Uri "http://127.0.0.1:3001/v1/mail/inbox/BAPert?unread=true" -Method GET -Headers $headers
```

Returns `data.messages[]` with `inbox_id`, `from_agent`, `subject`, `body`, `created_at`, `importance`.

For all messages (read + unread), drop the `?unread=true`:
```powershell
Invoke-RestMethod -Uri "http://127.0.0.1:3001/v1/mail/inbox/BAPert" -Method GET -Headers $headers
```

## Read a specific message (mark as read)

The inbox listing already includes the body. To explicitly mark a message read:

```powershell
Invoke-RestMethod -Uri "http://127.0.0.1:3001/v1/mail/inbox/BAPert/read-all" -Method POST -Headers $headers
```

## Send a message

**Pass JSON as `-Body` directly. Do NOT use `-InFile` / `Out-File`.** Windows PowerShell 5.1's `Out-File -Encoding utf8` adds a UTF-8 BOM that breaks the API's JSON parser ("input does not contain any JSON tokens"). The reliable pattern is to build the hashtable, convert to a JSON string, and pass the string straight in:

```powershell
$payload = @{
    from_agent = "BAPert"
    to = @("Aurum")
    subject = "Spec ready for review"
    body = "Body text here. Markdown supported."
    body_format = "markdown"
    importance = "normal"
}
$json = $payload | ConvertTo-Json -Depth 6 -Compress
$headers = @{ "X-ACP-Agent" = "BAPert" }

Invoke-RestMethod `
    -Uri "http://127.0.0.1:3001/v1/mail/send" `
    -Method POST `
    -Headers $headers `
    -ContentType "application/json; charset=utf-8" `
    -Body $json
```

`importance` is `"high"` | `"normal"` | `"low"`. `body_format` is `"markdown"` | `"plain"`.

### Multi-line bodies — use a here-string

For longer bodies with markdown, code fences, or special characters, build the body as a here-string and put it in the hashtable. The here-string handles newlines, backticks, and unicode safely; `ConvertTo-Json` will escape them correctly:

```powershell
$bodyText = @"
# Heading

Multi-line markdown body. Code fences:

``````
example code
``````

— Signed
"@

$payload = @{
    from_agent = "BAPert"
    to = @("Aurum")
    subject = "Status"
    body = $bodyText
    body_format = "markdown"
    importance = "normal"
}
$json = $payload | ConvertTo-Json -Depth 6 -Compress
Invoke-RestMethod -Uri "http://127.0.0.1:3001/v1/mail/send" -Method POST `
    -Headers @{ "X-ACP-Agent" = "BAPert" } `
    -ContentType "application/json; charset=utf-8" `
    -Body $json
```

### Multi-recipient

```powershell
to = @("NextPert", "DotNetPert", "QAPert")
```

## Reply to a thread

Pass `thread_id` from the original message in your send payload — same `Invoke-RestMethod` pattern as above:

```powershell
$payload = @{
    from_agent = "BAPert"
    to = @("Aurum")
    subject = "RE: Spec ready for review"
    body = "Reply text"
    body_format = "markdown"
    thread_id = "551d9cee499e4894"
}
$json = $payload | ConvertTo-Json -Depth 6 -Compress
Invoke-RestMethod -Uri "http://127.0.0.1:3001/v1/mail/send" -Method POST `
    -Headers @{ "X-ACP-Agent" = "BAPert" } `
    -ContentType "application/json; charset=utf-8" `
    -Body $json
```

## List teammates

```powershell
Invoke-RestMethod -Uri "http://127.0.0.1:3001/v1/mail/agents" -Method GET -Headers $headers
```

Returns the agent directory — useful when the user names someone you don't recognize.

## Common mistakes to avoid

- **`to_agent` is wrong.** The field is `to` (an array), not `to_agent`. ACP-API will reject a payload using the singular form.
- **Don't write the JSON to a file with `Out-File -Encoding utf8`.** PowerShell 5.1 adds a UTF-8 BOM that breaks the API parser, returning "input does not contain any JSON tokens". Use `-Body $json` with the string directly per the recipes above.
- **Don't wrap the payload in a `request: { ... }` envelope.** The fields go at the top level. Wrapping returns "from_agent required."
- **Inline `-d` in curl** mangles unicode on Windows (em-dashes, smart quotes, emoji get re-encoded by the console codepage). If you must use curl, write the file with `[System.IO.File]::WriteAllText($path, $json, [System.Text.UTF8Encoding]::new($false))` to skip the BOM. Otherwise prefer `Invoke-RestMethod -Body $json`.
- **Don't drop `X-ACP-Agent`.** Without it the proxy can't resolve who you are; the request returns 401.
- **Don't fabricate agent names.** If `to: ["Reasonable-sounding-name"]` returns 404 from the API, list teammates first.

## When to send mail vs use the chat UI

- **Mail** — durable, threaded, async. Use for handoffs, status reports, decisions, anything that should survive the session.
- **Chat (terminal)** — synchronous, ephemeral. Use for in-session collaboration that doesn't need to persist.

When in doubt: if the user said "tell BAPert" or "let DotNetPert know", use mail.
