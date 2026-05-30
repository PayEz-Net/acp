---
name: vibe-sql
description: Query VibeSQL PostgreSQL databases. Use for reading/writing data, checking agent profiles, viewing mail, inspecting schemas. Examples - 'check my inbox', 'show agents table', 'query my profile', 'list tables'
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

## Quick Queries

### Check Your Agent Profile
```sql
SELECT name, identity_md, role_md 
FROM vibe.global_vibe_agents 
WHERE name = 'YOUR_AGENT_NAME'
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
  -d '{"sql": "SELECT * FROM vibe.agents LIMIT 5"}'
```

## Safety

- SELECT preferred over modifications
- Always use WHERE for UPDATE/DELETE
- Check row counts before big operations
