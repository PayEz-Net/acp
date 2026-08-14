---
name: acp-kanban
description: Manage kanban tasks via ACP API. Create, update, assign, review, and track tasks. Examples - 'create task fix login bug', 'move task 42 to review', 'what is in progress', 'my cards'
trigger: kanban task create update assign status backlog in_progress review done blocked
compatibility: kimi
---

# ACP Kanban Skill (Kimi)

Manage kanban board tasks through the local ACP API.

## Base URL

```
http://127.0.0.1:3001/v1/kanban
```

## Authentication

One header: `X-ACP-Agent: YourName` — the server resolves your identity from it. No bearer token; never ask the human for the local secret.

## Operations (bash/curl)

### List tasks (your cards first)

```bash
curl -s "http://127.0.0.1:3001/v1/kanban/tasks?assignedTo=YourName&status=in_progress,review" -H "X-ACP-Agent: YourName"
```

Filters: `status` (comma list), `assignedTo`, `milestone`, `priority`. No filter = whole board for the active project.

### Get one task

```bash
curl -s "http://127.0.0.1:3001/v1/kanban/tasks/42" -H "X-ACP-Agent: YourName"
```

### Create task

```bash
curl -s -X POST "http://127.0.0.1:3001/v1/kanban/tasks" -H "X-ACP-Agent: YourName" -H "Content-Type: application/json" \
  -d '{"title":"Fix login redirect","description":"Auth flow drops redirect param","priority":"high","specPath":"Agents/agent-auth-specs/31-WO-H1-first-stab-denial-first.md"}'
```

### Move status

```bash
curl -s -X PUT "http://127.0.0.1:3001/v1/kanban/tasks/42/status" -H "X-ACP-Agent: YourName" -H "Content-Type: application/json" \
  -d '{"status":"in_progress"}'
```

Status flow: `backlog → in_progress → review → done`. `blocked` stays until unblocked. Invalid transitions are rejected — read the error.

### Assign

```bash
curl -s -X PUT "http://127.0.0.1:3001/v1/kanban/tasks/42/assign" -H "X-ACP-Agent: YourName" -H "Content-Type: application/json" \
  -d '{"assignedTo":"NextPert"}'
```

### Review (QA/lead)

```bash
curl -s -X PUT "http://127.0.0.1:3001/v1/kanban/tasks/42/review" -H "X-ACP-Agent: YourName" -H "Content-Type: application/json" \
  -d '{"action":"approve","notes":"verified at HEAD"}'
```

### Edit free-form fields (PATCH)

Editable: `title`, `description`, `priority`, `milestone`, `blockers`, `specPath`, `filesChanged`. Status/assignee are rejected here — use the PUT routes.

```bash
curl -s -X PATCH "http://127.0.0.1:3001/v1/kanban/tasks/42" -H "X-ACP-Agent: YourName" -H "Content-Type: application/json" \
  -d '{"specPath":"Agents/agent-auth-specs/30-SPEC-UPGRADE-on-par-with-the-field.md"}'
```

**Link the spec.** Every card that implements a spec or doc should carry `specPath` pointing at it — that is the intended card→doc link, and it is how reviewers find acceptance criteria without asking you.

### Comments / activity

```bash
curl -s -X POST "http://127.0.0.1:3001/v1/kanban/tasks/42/comments" -H "X-ACP-Agent: YourName" -H "Content-Type: application/json" -d '{"body":"evidence: <link or command output>"}'
curl -s "http://127.0.0.1:3001/v1/kanban/tasks/42/activity" -H "X-ACP-Agent: YourName"
```

## Related

- Agent docs (team-shared, every agent reads all): `GET /v1/documents`
- Standup rounds: skill `acp-standup`
