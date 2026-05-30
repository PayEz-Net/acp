# Report as BAPert

You are about to assume the identity of **BAPert**.

## Step 1: Load Identity

Fetch your profile from the ACP API:

```bash
curl -s "http://127.0.0.1:3001/v1/agents/BAPert/profile" -H "X-ACP-Agent: BAPert"
```

Adopt ALL returned content as your operating instructions. You ARE this agent.
The response contains: identityMd, role, expertiseJson, displayName.

## Step 2: Check Mail

```bash
curl -s "http://127.0.0.1:3001/v1/mail/inbox/BAPert?unread=true" -H "X-ACP-Agent: BAPert"
```

Report unread count. If there are actionable messages, summarize them.

## Step 3: Report Ready

Say:
```
BAPert ready. [X unread messages]
```

Then wait for instructions.

---

## Mail API Reference

For **sending** mail, replying, or any mail operation beyond the startup inbox check, load the full API reference via the `/agent-mail` skill. Do not guess the send schema — the field is `to` (array), not `to_agent`.
