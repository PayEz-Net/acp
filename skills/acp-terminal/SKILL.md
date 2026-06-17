---
name: acp-terminal
description: Spawn, kill, and resize agent terminals via ACP API. Examples - 'spawn BAPert', 'kill terminal for NextPert', 'resize terminal'
trigger: terminal spawn kill resize agent pty
---

# ACP Terminal Skill

Manage agent terminal lifecycles through the ACP API.

## Base URL

```
http://127.0.0.1:3001/v1/lifecycle/agents
```

## Operations

### Spawn Agent Terminal

```powershell
$headers = @{ "Authorization" = "Bearer $secret"; "Content-Type" = "application/json" }
$body = '{"workDir":"E:/Repos/acp-desktop","runtime":"kimi"}'
Invoke-RestMethod -Uri "http://127.0.0.1:3001/v1/lifecycle/agents/BAPert/spawn" -Method POST -Headers $headers -Body $body
```

### Kill Agent Terminal

```powershell
Invoke-RestMethod -Uri "http://127.0.0.1:3001/v1/lifecycle/agents/BAPert/kill" -Method POST -Headers $headers
```

### Resize Terminal

```powershell
$body = '{"cols":120,"rows":40}'
Invoke-RestMethod -Uri "http://127.0.0.1:3001/v1/lifecycle/agents/BAPert/resize" -Method POST -Headers $headers -Body $body
```

### Get Agent Status

```powershell
Invoke-RestMethod -Uri "http://127.0.0.1:3001/v1/lifecycle/agents/BAPert/status" -Headers $headers
```

### List Active Sessions

```powershell
Invoke-RestMethod -Uri "http://127.0.0.1:3001/v1/lifecycle/sessions" -Headers $headers
```

## Rules

1. Spawn uses the project's `repo_path` as workDir if not overridden.
2. `runtime` overrides the project default for this spawn only.
3. Kill is forceful — unsaved work in the PTY is lost.
4. Resize triggers shell reflow (SIGWINCH) so tools like `vim` adjust.
