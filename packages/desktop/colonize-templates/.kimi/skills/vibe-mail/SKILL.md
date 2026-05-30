---
name: vibe-mail
description: Send and read agent mail through ACP-API — collaborate with teammates by checking inbox, reading messages, sending mail, and replying to threads. Trigger on "send mail", "check mail", "check inbox", "reply to", "mail [agent]", or any mail/messaging intent.
trigger: vibe-mail, send mail, check mail, check inbox, mail
compatibility: kimi
---

# /vibe-mail — Agent Mail (Kimi)

You are a mail-enabled AI agent running under ACP. You can send messages to teammates, check your inbox, read messages, and follow conversation threads — all through the **ACP-API mail proxy** at `http://127.0.0.1:3001/v1/mail/*`.

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
