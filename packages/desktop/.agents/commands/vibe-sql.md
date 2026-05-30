# VibeSQL — Query the Vibe Database

Execute SQL queries against the Vibe PostgreSQL database via the VibeSQL API.

## API Access

**Endpoint:** `http://127.0.0.1:52411/v1/query`

**Required headers:**
```
Authorization: Secret ${VIBESQL_SECRET}
Content-Type: application/json
```

## Query

```bash
curl -s -X POST "http://127.0.0.1:52411/v1/query" \
  -H "Authorization: Secret ${VIBESQL_SECRET}" \
  -H "Content-Type: application/json" \
  -d '{"sql": "YOUR SQL HERE"}'
```

## Key Tables

| Schema.Table | Purpose |
|-------------|---------|
| `vibe.global_vibe_agents` | Global agent roster (real table, not documents) |
| `vibe.collection_schemas` | Schema definitions per client/collection |
| `vibe.documents` | All document data (agent mail, projects, etc.) |

## Common Queries

### List global agents
```sql
SELECT id, name, display_name, role FROM vibe.global_vibe_agents ORDER BY id
```

### List schemas
```sql
SELECT collection_schema_id, client_id, collection, version, is_active FROM vibe.collection_schemas WHERE is_active = true ORDER BY client_id, collection
```

### Count documents by collection
```sql
SELECT collection, table_name, count(*) as cnt FROM vibe.documents WHERE deleted_at IS NULL GROUP BY collection, table_name ORDER BY collection, table_name
```

## Rules

- This is PostgreSQL. Use PG syntax, JSONB operators (`->`, `->>`, `@>`), `information_schema`.
- NEVER use SQLite syntax (`sqlite_master`, `PRAGMA`, `json_extract`).
- Data queries: 10KB limit. Schema operations (targeting `collection_schemas`): 512KB limit.
- Documents store data as JSONB in the `data` column. Access fields with `data->>'field_name'`.
