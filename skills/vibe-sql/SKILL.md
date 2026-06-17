---
name: vibe-sql
description: Query VibeSQL PostgreSQL databases. Use for reading agent profiles, checking mail, inspecting schemas. Data-driven agent configuration lives in vibe.global_vibe_agents table.
triggers: ["query", "check inbox", "show agents", "list tables", "describe"]
---

# VibeSQL Query Skill for Kimi

Query VibeSQL databases via HTTP API.

## Endpoint

```
POST https://api.idealvibe.online/v1/query
Content-Type: application/json
```

## Request Format

```json
{"sql": "YOUR SQL HERE"}
```

## Agent Profile Schema (vibe.global_vibe_agents)

| Column | Type | Purpose |
|--------|------|---------|
| `name` | string | Agent identifier (e.g., 'BAPert') |
| `display_name` | string | Human-readable name |
| `role` | string | Role type (backend-developer, frontend-developer, etc.) |
| `identity_md` | text | Self-concept/identity statement |
| `role_md` | text | Capabilities and responsibilities |
| `philosophy_md` | text | Core principles and decision framework |
| `communication_md` | text | Communication style and constraints |
| `response_pattern_md` | text | Workflow pattern for tasks |
| `expertise_json` | jsonb | Technical skills as JSON array |

## Quick Queries

### Load Agent Persona (for "report as")

```sql
SELECT 
  name,
  display_name,
  role,
  identity_md,
  role_md,
  philosophy_md,
  communication_md,
  response_pattern_md,
  expertise_json
FROM vibe.global_vibe_agents
WHERE name = 'YOUR_AGENT_NAME'
```

### List All Available Agents

```sql
SELECT name, display_name, role
FROM vibe.global_vibe_agents
ORDER BY name
```

### Check Mail Inbox

```sql
SELECT message_id, from_agent, subject, created_at 
FROM vibe.agent_mail 
WHERE to_agent = 'YOUR_AGENT_NAME' AND read_at IS NULL
ORDER BY created_at DESC
```

### List Tables

```sql
SELECT table_name 
FROM information_schema.tables 
WHERE table_schema = 'vibe'
ORDER BY table_name
```

### Describe Table

```sql
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_name = 'TABLE_NAME' AND table_schema = 'vibe'
ORDER BY ordinal_position
```

## Execute

```bash
curl -s -X POST https://api.idealvibe.online/v1/query \
  -H "Content-Type: application/json" \
  -d '{"sql": "SELECT * FROM vibe.global_vibe_agents WHERE name = '\''BAPert'\''"}'
```

## Safety

- SELECT preferred over modifications
- Always use WHERE for UPDATE/DELETE
- Check row counts before big operations
- The database is the source of truth for agent configuration
