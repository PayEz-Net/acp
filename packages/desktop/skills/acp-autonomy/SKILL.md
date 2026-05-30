---
name: acp-autonomy
description: Start and stop unattended mode, check autonomy status, and manage standup entries via ACP API. Examples - 'start unattended mode', 'check autonomy status', 'add standup entry'
trigger: autonomy unattended standup start stop status
---

# ACP Autonomy Skill

Manage autonomous agent operation through the ACP API.

## Base URL

```
http://127.0.0.1:3001/v1/autonomy
```

## Operations

### Start Unattended Mode

```powershell
$headers = @{ "Authorization" = "Bearer $secret"; "Content-Type" = "application/json" }
$body = '{"stopCondition":"milestone","maxRuntimeHours":8,"leadAgent":"BAPert","pingIntervalMinutes":10}'
Invoke-RestMethod -Uri "http://127.0.0.1:3001/v1/autonomy/unattended/start" -Method POST -Headers $headers -Body $body
```

### Stop Unattended Mode

```powershell
$body = '{"reason":"manual"}'
Invoke-RestMethod -Uri "http://127.0.0.1:3001/v1/autonomy/unattended/stop" -Method POST -Headers $headers -Body $body
```

### Get Status

```powershell
Invoke-RestMethod -Uri "http://127.0.0.1:3001/v1/autonomy/status" -Headers $headers
```

### Add Standup Entry

```powershell
$body = '{"agentName":"NextPert","entryType":"shipped","summary":"Fixed navbar bug #42","taskId":42}'
Invoke-RestMethod -Uri "http://127.0.0.1:3001/v1/autonomy/standup" -Method POST -Headers $headers -Body $body
```

### Get Standup

```powershell
Invoke-RestMethod -Uri "http://127.0.0.1:3001/v1/autonomy/standup" -Headers $headers
```

## Stop Conditions

- `milestone` — stops when all tasks in current milestone are done
- `max_runtime` — stops after maxRuntimeHours
- `blocker` — stops when 2+ tasks are blocked
- `review_queue` — stops when 3+ tasks are in review
- `manual` — human stops it

## Rules

1. Unattended mode sends ping mails to leadAgent every pingIntervalMinutes.
2. Dead man's switch auto-stops if no SSE clients connect for 5 minutes.
3. Standup entries feed into the daily standup report.
