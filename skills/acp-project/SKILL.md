---
name: acp-project
description: Switch projects, manage project settings, and view project team via ACP API. Examples - 'switch to project 12', 'show my projects', 'who is on this team'
trigger: project switch team list projects settings
---

# ACP Project Skill

Manage project context and team composition through the ACP API.

## Base URL

```
http://127.0.0.1:3001/v1/projects
```

## Operations

### List Projects

```powershell
$headers = @{ "Authorization" = "Bearer $secret"; "Content-Type" = "application/json" }
Invoke-RestMethod -Uri "http://127.0.0.1:3001/v1/projects" -Headers $headers
```

### Switch Active Project

```powershell
$body = '{"project_id":12}'
Invoke-RestMethod -Uri "http://127.0.0.1:3001/v1/projects/switch" -Method POST -Headers $headers -Body $body
```

### Get Project Team

```powershell
Invoke-RestMethod -Uri "http://127.0.0.1:3001/v1/projects/12/team" -Headers $headers
```

### Update Project Settings

```powershell
$body = '{"name":"ACP v1.0","runtime_choice":"kimi"}'
Invoke-RestMethod -Uri "http://127.0.0.1:3001/v1/projects/12" -Method PATCH -Headers $headers -Body $body
```

### Get Project Activity

```powershell
Invoke-RestMethod -Uri "http://127.0.0.1:3001/v1/projects/12/activity" -Headers $headers
```

## Rules

1. Project switch requires a restart of agent terminals for the new workDir to take effect.
2. `runtime_choice` affects which LLM provider spawns new agents for this project.
3. Team roster is per-project; canonical agents (BAPert, QAPert) are auto-seeded.
