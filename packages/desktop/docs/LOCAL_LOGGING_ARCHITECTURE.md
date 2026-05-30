# Local Logging Architecture with VibeSQL Micro

## Problem

- Graylog = external dependency (not for commercial desktop)
- Flat files = unsearchable, disk hog, pain to manage
- SQLite = works but we're building VibeSQL, let's dogfood it

## Solution: VibeSQL Micro for Desktop Logging

### What is VibeSQL Micro?

- **Single binary** (~16-77MB with embedded PostgreSQL 16)
- **HTTP API** - Same interface as cloud VibeSQL
- **Zero dependencies** - Self-contained
- **Local only** - No external network calls

### Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    ACP Desktop (Electron)                   │
│  ┌───────────────────────────────────────────────────────┐  │
│  │           VibeSQL Micro (Embedded)                    │  │
│  │  ┌───────────────────────────────────────────────┐   │  │
│  │  │  PostgreSQL 16 (internal, port 5433)         │   │  │
│  │  │  - logs table                                │   │  │
│  │  │  - events table                              │   │  │
│  │  │  - metrics table                             │   │  │
│  │  └───────────────────────────────────────────────┘   │  │
│  │  HTTP API on localhost:15432                         │  │
│  └───────────────────────────────────────────────────────┘  │
│                          │                                  │
│  ┌───────────────────────┼───────────────────────┐         │
│  │                       ▼                       │         │
│  │  ┌────────────┐  ┌────────────┐  ┌─────────┐ │         │
│  │  │ Main Proc  │  │ Renderer   │  │ Agents  │ │         │
│  │  │ Logs here ─┼──► Query here │  │ View    │ │         │
│  │  └────────────┘  └────────────┘  └─────────┘ │         │
│  └───────────────────────────────────────────────┘         │
└─────────────────────────────────────────────────────────────┘
```

### Schema

```sql
-- Local logging schema
CREATE TABLE logs (
  id SERIAL PRIMARY KEY,
  timestamp TIMESTAMPTZ DEFAULT NOW(),
  level TEXT CHECK (level IN ('debug', 'info', 'warn', 'error', 'fatal')),
  module TEXT,           -- 'auth', 'api', 'lifecycle', 'mail', etc.
  agent TEXT,            -- Which agent (if agent-related)
  message TEXT,
  context JSONB,         -- Structured data
  source TEXT            -- 'main', 'renderer', 'agent-terminal'
);

CREATE TABLE events (
  id SERIAL PRIMARY KEY,
  timestamp TIMESTAMPTZ DEFAULT NOW(),
  event_type TEXT,       -- 'agent_spawned', 'mail_sent', 'error_occurred'
  agent TEXT,
  details JSONB
);

-- Full-text search index
CREATE INDEX idx_logs_search ON logs USING GIN (to_tsvector('english', message));
```

### API (Same as Cloud VibeSQL)

```bash
# Insert log (from main process)
POST http://localhost:15432/v1/query
{
  "sql": "INSERT INTO logs (level, module, message, context) VALUES ('error', 'api', 'Connection failed', '{\"retry\": 3}')"
}

# Query logs (from renderer or agent)
POST http://localhost:15432/v1/query
{
  "sql": "SELECT * FROM logs WHERE level = 'error' AND timestamp > NOW() - INTERVAL '1 hour' ORDER BY timestamp DESC"
}

# Search logs
POST http://localhost:15432/v1/query
{
  "sql": "SELECT * FROM logs WHERE to_tsvector('english', message) @@ to_tsquery('connection')"
}
```

### Benefits

| Feature | Flat Files | SQLite | VibeSQL Micro |
|---------|-----------|--------|---------------|
| Structured | ❌ | ✅ | ✅ |
| Queryable | ❌ (grep) | ✅ (SQL) | ✅ (SQL + HTTP) |
| Full-text search | ❌ | ⚠️ (extension) | ✅ (PostgreSQL) |
| JSON support | ❌ | ⚠️ | ✅ (JSONB) |
| Same API as cloud | ❌ | ❌ | ✅ |
| Time-series | ❌ | ⚠️ | ✅ |
| Disk management | ❌ | ⚠️ | ✅ (PostgreSQL) |

### Implementation

#### 1. Bundle VibeSQL Micro

```
acp-desktop/resources/
├── bin/
│   ├── vibesql-micro-win.exe  ← bundled
│   ├── vibesql-micro-mac
│   └── vibesql-micro-linux
```

#### 2. Startup Sequence

```typescript
// main.ts
import { spawn } from 'child_process';

async function startLocalVibeSQL() {
  const vibeMicro = spawn('./resources/bin/vibesql-micro', [
    '--data-dir', app.getPath('userData') + '/vibesql-local',
    '--http-port', '15432',
    '--pg-port', '5433',
  ]);
  
  // Wait for ready
  await waitForHealthy('http://localhost:15432/health');
  
  // Create tables if not exist
  await initLoggingSchema();
}
```

#### 3. Logging Wrapper

```typescript
// logger.ts
import { logToVibeSQL } from './vibesql-logger';

export function log(level: string, module: string, message: string, context?: object) {
  // Still console.log for dev visibility (optional)
  if (process.env.NODE_ENV === 'development') {
    console.log(`[${module}] ${message}`);
  }
  
  // Primary: structured local DB
  logToVibeSQL(level, module, message, context);
}
```

#### 4. Agent Access

Agents can query logs via the skill:

```bash
# Check recent errors
node -e "fetch('http://127.0.0.1:15432/v1/query', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    sql: \"SELECT timestamp, level, message FROM logs WHERE level = 'error' ORDER BY timestamp DESC LIMIT 10\"
  })
}).then(r => r.json()).then(console.log)"
```

### Rotation & Cleanup

```sql
-- Automatic cleanup (runs every hour)
DELETE FROM logs WHERE timestamp < NOW() - INTERVAL '7 days';
DELETE FROM events WHERE timestamp < NOW() - INTERVAL '30 days';

-- Vacuum to reclaim space
VACUUM;
```

### Migration from Current

1. Keep current console logging for dev visibility (optional)
2. Add VibeSQL Micro as primary structured log store
3. Provide agent skill for log querying
4. Update ACP UI to show log viewer

### Disk Usage Estimate

| Logs per day | Size per day | 7 days | 30 days |
|--------------|--------------|--------|---------|
| 1,000 | 500KB | 3.5MB | 15MB |
| 10,000 | 5MB | 35MB | 150MB |
| 100,000 | 50MB | 350MB | 1.5GB |

With 7-day retention: manageable for desktop.

## Decision

**Use VibeSQL Micro for local logging.**

- Dogfoods our own product
- Same SQL/HTTP API as cloud
- Queryable, searchable, structured
- No external dependencies
- Agents can access their own logs
