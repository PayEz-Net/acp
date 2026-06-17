# VibeSQL — Query the Vibe Database

Query the Vibe PostgreSQL database through the **`vibe-sql` skill**. The skill
authenticates over your session and routes to the correct VibeSQL endpoint for
you, so it works the same on any machine — there is **no endpoint URL or secret
to manage here**. Do NOT hand-roll raw HTTP calls to a database host.

## How to query

Invoke the `vibe-sql` skill and either describe what you want in natural language
or hand it SQL directly, e.g.:

> Use the **vibe-sql** skill: `SELECT id, name, display_name, role FROM vibe.global_vibe_agents ORDER BY id`

The skill handles auth + the cloud endpoint and returns the rows.

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
