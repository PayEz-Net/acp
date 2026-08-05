---
name: acp-kanban
description: Manage kanban tasks via ACP API. Create, update, assign, and track tasks. Examples - 'create task fix login bug', 'move task 42 to review', 'what is in progress'
trigger: kanban task create update assign status backlog in_progress review done blocked
---

# ACP Kanban Skill

Manage kanban board tasks through the local ACP API.

## Base URL

```
http://127.0.0.1:3001/v1/kanban
```

## Authentication

Use local auth secret from `window.electronAPI.getLocalSecret()` or the stored Bearer token.

## Operations

### List Tasks

```powershell
$headers = @{ "Authorization" = "Bearer $secret"; "Content-Type" = "application/json" }
Invoke-RestMethod -Uri "http://127.0.0.1:3001/v1/kanban/tasks" -Headers $headers
```

### Create Task

```powershell
$body = '{"title":"Fix login redirect","description":"Auth flow drops redirect param","status":"backlog","priority":"high","milestone":"acp-v1"}'
Invoke-RestMethod -Uri "http://127.0.0.1:3001/v1/kanban/tasks" -Method POST -Headers $headers -Body $body
```

### Update Status — dedicated endpoint, NOT PATCH

**`PATCH /tasks/:id` rejects a `status` field.** Status has its own endpoint:

```bash
curl -s -X PUT "http://127.0.0.1:3001/v1/kanban/tasks/42/status" \
  -H "X-ACP-Agent: YourName" -H "Content-Type: application/json" \
  -d '{"status":"in_progress"}'
```

> Sending status via PATCH returns:
> `"Cannot edit status via PATCH — use PUT /tasks/:id/status"`

### Assign — also a dedicated endpoint, and the field is `agent`

```bash
curl -s -X PUT "http://127.0.0.1:3001/v1/kanban/tasks/42/assign" \
  -H "X-ACP-Agent: YourName" -H "Content-Type: application/json" \
  -d '{"agent":"NextPert"}'
```

> **The field is `agent`, not `assignedTo`.** Sending `{"assignedTo":"..."}` returns
> `"Agent is required"` — which reads like a missing value rather than a wrong field name.

### PATCH — for everything else

`PATCH /tasks/:id` is correct for `title`, `description`, `priority`, `specPath`, `milestone`:

```bash
curl -s -X PATCH "http://127.0.0.1:3001/v1/kanban/tasks/42" \
  -H "X-ACP-Agent: YourName" -H "Content-Type: application/json" \
  -d '{"specPath":"docs/16-example.md"}'
```

### Review Task

```powershell
$body = '{"action":"approve","notes":"LGTM, ship it"}'
Invoke-RestMethod -Uri "http://127.0.0.1:3001/v1/kanban/tasks/42/review" -Method POST -Headers $headers -Body $body
```

## Status Flow — transitions are ENFORCED, no skipping

```
backlog → in_progress → review → done
```

**You cannot skip a state.** Moving `backlog → review` directly is rejected:

> `"Cannot move task from 'backlog' to 'review'. Allowed: in_progress"`

To land a card in `review` from `backlog`, issue **two** calls — `in_progress`, then `review`.

Blocked tasks return to backlog or stay blocked until unblocked.

---

## Reading the board — the list endpoint is unreliable

**Three defects. Fetch by id when the answer matters.**

1. **It silently caps by id and returns no pagination metadata**, so a short list is
   indistinguishable from a complete one. There is no field telling you results were dropped.
2. **`assignedTo` is omitted from list results**, so every card reads as unowned.
3. **It can return zero tasks for a project that has them** — observed on a populated board.

```bash
# unreliable for completeness or ownership
curl -s ".../v1/kanban/tasks" -H "X-ACP-Agent: YourName"

# authoritative
curl -s ".../v1/kanban/tasks/167116" -H "X-ACP-Agent: YourName"
```

> **If the board shows your card as unowned, absent, or the list looks short — that is the
> endpoint, not the board.** Confirm by id before concluding a card moved, vanished, or lost
> its assignee.

**Project scoping:** an unscoped path resolves against the caller's *active* project. If that
is not the project holding the card you get `"Task N not found in project M"` — note the
project number in the error, which tells you where it actually looked. Scope explicitly with
`/v1/projects/{projectId}/kanban/tasks/{id}` when in doubt.

---

## Note on the examples

The PowerShell examples above are original to this skill. **Agents on macOS/Linux should use
`curl`**, as shown in the corrected sections. Authentication in practice is the
`X-ACP-Agent: YourName` header — the same identity used for mail.
