---
name: acp-documents
description: Manage project documents via ACP API. List, read, create, update, and delete documents scoped to the active project. Use when the user asks to show docs, list documents, read a doc, create project documentation, update a document, or delete a document.
---

# ACP Documents Skill

Manage project-scoped documents through the ACP API.

## Base URL

```
http://127.0.0.1:3001/v1/documents
```

## Operations

### List Documents

List all documents, or filter by active project:

```powershell
$headers = @{ "X-ACP-Agent" = "AGENTNAME" }
# All documents
Invoke-RestMethod -Uri "http://127.0.0.1:3001/v1/documents" -Headers $headers

# Filtered by project_id
Invoke-RestMethod -Uri "http://127.0.0.1:3001/v1/documents?project_id=14" -Headers $headers
```

### Get Single Document

```powershell
$headers = @{ "X-ACP-Agent" = "AGENTNAME" }
Invoke-RestMethod -Uri "http://127.0.0.1:3001/v1/documents/1" -Headers $headers
```

### Create Document

```powershell
$headers = @{ "X-ACP-Agent" = "AGENTNAME"; "Content-Type" = "application/json" }
$body = @{
  project_id = 14
  title = "UMI Architecture"
  content_md = "# Architecture..."
  type = "context"
  version = "1.0"
} | ConvertTo-Json
Invoke-RestMethod -Uri "http://127.0.0.1:3001/v1/documents" -Method POST -Headers $headers -Body $body
```

### Update Document

```powershell
$headers = @{ "X-ACP-Agent" = "AGENTNAME"; "Content-Type" = "application/json" }
$body = @{
  title = "Updated Title"
  content_md = "# Updated..."
} | ConvertTo-Json
Invoke-RestMethod -Uri "http://127.0.0.1:3001/v1/documents/1" -Method PUT -Headers $headers -Body $body
```

### Delete Document

```powershell
$headers = @{ "X-ACP-Agent" = "AGENTNAME" }
Invoke-RestMethod -Uri "http://127.0.0.1:3001/v1/documents/1" -Method DELETE -Headers $headers
```

## Document Types

| Type | Purpose |
|------|---------|
| `context` | Project context, architecture, scope |
| `agents` | Agent conventions, coding standards |
| `planning` | Roadmaps, phases, execution boards |
| `reference` | API docs, schemas, guides |
| `checklist` | Testing, deployment, security checks |

## Rules

1. Always scope documents to a `project_id`. Global docs use `project_id: null`.
2. `title` and `content_md` are required for create.
3. `type` defaults to `reference` if omitted.
4. Prefer updating existing docs over creating duplicates.
5. Large content (>50KB) should be split into multiple docs or stored as references.
