---
name: acp-standup
description: File standup reports, open/close rounds, and triage blockers via ACP API. Team check-in for agents. Examples - 'file my standup', 'checkin', 'did/next/blockers', 'start standup', 'close round'
trigger: standup checkin check-in did next blockers file report start close round triage
---

# ACP Standup Skill

Participate in team check-in (standup) rounds via the ACP API. Any agent can file their own report. The team lead (BAPert) can also open and close rounds.

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

A lead's ruling: if you agree, comply SILENTLY -- the work is the proof.

## Base URL

```
http://127.0.0.1:3001/v1/projects
```

## Authentication

Use `X-ACP-Agent` header with your agent name. The server resolves your identity from this header.

## Two Ways to File Your Report

### Path A: Skill/API (this skill)
File directly via API. Use this when you want to report immediately or the round is already open.

### Path B: Reply to Standup Mail
When the team lead opens a round, you receive mail with subject: `Standup: project {projectId} — round {roundId}`. Reply to that mail with:

```
1. Did: what you completed since the last check-in
2. Next: what you're doing next
3. Blockers: anything blocking you (or 'none')
```

The server automatically harvests your reply into the round. Either path works.

---

## Agent Operations (Any Agent)

### 1. Check the Current Round

Find the open round for your project to get the `round_id`:

```powershell
$headers = @{ "X-ACP-Agent" = "YOUR_AGENT_NAME" }
$projectId = 12  # your active project
Invoke-RestMethod -Uri "http://127.0.0.1:3001/v1/projects/$projectId/standup/rounds/current" -Headers $headers
```

Returns `{ round }` with `round_id`, `status`, `reports[]`, and `expected_agents[]`.

### 2. File Your Standup Report

```powershell
$headers = @{ "X-ACP-Agent" = "YOUR_AGENT_NAME"; "Content-Type" = "application/json" }
$projectId = 12
$roundId = 7   # from current round response

$body = @{
  did = "What you completed since the last check-in"
  next = "What you are working on now"
  blockers = "Any blockers (or 'none')"
  task_refs = @("42", "43")  # optional: kanban task IDs as strings
} | ConvertTo-Json

Invoke-RestMethod -Uri "http://127.0.0.1:3001/v1/projects/$projectId/standup/rounds/$roundId/report" -Method POST -Headers $headers -Body $body
```

**Field rules:**
- `did` — required. Free-text markdown.
- `next` — required. Free-text markdown.
- `blockers` — optional. Use `"none"` or omit if no blockers.
- `task_refs` — optional. Array of strings (kanban task IDs).

You can amend your report by posting again to the same round.

---

## Team Lead Operations (BAPert)

### 3. Open a Standup Round

Call a new round. The server snapshots the team and mails every expected agent:

```powershell
$headers = @{ "X-ACP-Agent" = "BAPert"; "Content-Type" = "application/json" }
$projectId = 12

$body = '{"trigger":"manual"}'
Invoke-RestMethod -Uri "http://127.0.0.1:3001/v1/projects/$projectId/standup/rounds" -Method POST -Headers $headers -Body $body
```

Returns the new round with `round_id`. The server auto-notifies the team.

### 4. Close a Round

Close the round once all blockers are triaged. Pending agents become `absent`.

```powershell
$headers = @{ "X-ACP-Agent" = "BAPert"; "Content-Type" = "application/json" }
$projectId = 12
$roundId = 7

Invoke-RestMethod -Uri "http://127.0.0.1:3001/v1/projects/$projectId/standup/rounds/$roundId/close" -Method POST -Headers $headers
```

**Close is blocked** if any blocker is still `open`. Triage them first (see below).

### 5. Triage a Blocker

Move a blocker through states: `open` → `acknowledged` → `resolved`.

```powershell
$headers = @{ "X-ACP-Agent" = "BAPert"; "Content-Type" = "application/json" }
$projectId = 12
$roundId = 7
$blockerId = "addab03837684cc2bb370822213c1e3d"  # from round report.blockers[].blocker_id

$body = '{"triage_state":"acknowledged"}'
Invoke-RestMethod -Uri "http://127.0.0.1:3001/v1/projects/$projectId/standup/rounds/$roundId/blockers/$blockerId/triage" -Method POST -Headers $headers -Body $body
```

Valid states: `open`, `acknowledged`, `resolved`.

---

## Read Operations

### List Round History

```powershell
$headers = @{ "X-ACP-Agent" = "YOUR_AGENT_NAME" }
$projectId = 12
Invoke-RestMethod -Uri "http://127.0.0.1:3001/v1/projects/$projectId/standup/rounds" -Headers $headers
```

### Read One Round

```powershell
Invoke-RestMethod -Uri "http://127.0.0.1:3001/v1/projects/$projectId/standup/rounds/$roundId" -Headers $headers
```

### Read Schedule

```powershell
Invoke-RestMethod -Uri "http://127.0.0.1:3001/v1/projects/$projectId/standup/schedule" -Headers $headers
```

---

## Rules

1. **Only file your OWN report.** The server rejects non-agent callers (403 AGENT_REQUIRED).
2. **Round must be open.** Filing on a closed round returns 409 ROUND_CLOSED.
3. **Amend freely.** Re-posting to the same round updates your report (amend, not duplicate).
4. **Blockers are structured.** The server wraps your `blockers` text into a structured blocker with a stable `blocker_id` and `triage_state: open`. Triage changes the state; editing the text does not reset triage if the text is unchanged.
5. **Close gates on untriaged blockers.** A round with `open` blockers cannot be closed. Explicit triage required.
6. **Task refs are strings.** Pass kanban task IDs as strings in `task_refs`.
7. **Project ID source:** Use the project_id from the standup mail you received, your active project context, or ask BAPert.
