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

### Update Status

```powershell
$body = '{"status":"in_progress","assignedTo":"NextPert"}'
Invoke-RestMethod -Uri "http://127.0.0.1:3001/v1/kanban/tasks/42" -Method PATCH -Headers $headers -Body $body
```

### Review Task

```powershell
$body = '{"action":"approve","notes":"LGTM, ship it"}'
Invoke-RestMethod -Uri "http://127.0.0.1:3001/v1/kanban/tasks/42/review" -Method POST -Headers $headers -Body $body
```

## Status Flow

backlog → in_progress → review → done

Blocked tasks return to backlog or stay blocked until unblocked.
