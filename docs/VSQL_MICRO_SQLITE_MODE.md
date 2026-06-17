# Making VibeSQL Micro "SQLite-Easy"

## The SQLite Bar

```javascript
// SQLite: Zero friction
import Database from 'better-sqlite3';
const db = new Database('./myapp.db');  // ← Just works
```

```javascript
// Current VibeSQL Micro: High friction
import { spawn } from 'child_process';

// 1. Find binary
// 2. Spawn process  
// 3. Wait for port
// 4. Handle crashes
// 5. Shutdown cleanup
```

## Target: `vsql-micro --sqlite-mode`

```javascript
// Goal: Same ergonomics as SQLite
import { createDatabase } from 'vibesql-micro/client';

const db = createDatabase('./myapp.vsql', { mode: 'embedded' });
// ← Just works. Zero startup. Single file.
```

## Technical Approaches

### Option 1: WASM PostgreSQL (Best Long-term)

```
┌─────────────────────────────────────────┐
│  Node.js / Electron Process             │
│  ┌───────────────────────────────────┐  │
│  │  PostgreSQL 16 (WASM)             │  │
│  │  ┌─────────────────────────────┐  │  │
│  │  │  Memory-mapped "disk"       │  │  │
│  │  │  Single-file storage        │  │  │
│  │  │  (Page server like SQLite)  │  │  │
│  │  └─────────────────────────────┘  │  │
│  │  ┌─────────────────────────────┐  │  │
│  │  │  HTTP server (WASM)         │  │  │
│  │  │  localhost:0 (random port)  │  │  │
│  │  └─────────────────────────────┘  │  │
│  └───────────────────────────────────┘  │
└─────────────────────────────────────────┘
```

**Implementation:**
- Compile PostgreSQL to WASM using Emscripten
- Replace filesystem calls with JS callbacks
- Single-file storage via custom buffer manager
- HTTP server in WASM (or message passing)

**Size target:** 5-8MB WASM binary (compressed)

**Prior art:**
- `pglite` (Electric SQL) - PG in WASM, but in-browser
- `sql.js` - SQLite in WASM (1.5MB)

**Challenge:** PostgreSQL is huge, threading model, filesystem assumptions

---

### Option 2: Pre-warmed Daemon (Best Near-term)

```bash
# User installs vsql-micro once per machine
npm install -g vibesql-micro

# One daemon runs for all apps
vsql-micro daemon --start

# Apps just connect (instant)
vsql-micro client ./myapp.db  # Uses daemon, feels like SQLite
```

```javascript
// Client library - zero startup
import { connect } from 'vibesql-micro/client';

const db = connect('./myapp.db', {
  daemonSocket: '~/.vsql-micro/daemon.sock'
});
// ← Feels like SQLite, daemon handles PG lifecycle
```

**Architecture:**

```
┌──────────────────────────────────────────┐
│  Shared vsql-micro Daemon (per user)     │
│  ┌────────────────────────────────────┐  │
│  │  PostgreSQL instance               │  │
│  │  ┌──────────┐ ┌──────────┐        │  │
│  │  │ Database │ │ Database │ ...    │  │
│  │  │ App A    │ │ App B    │        │  │
│  │  └──────────┘ └──────────┘        │  │
│  └────────────────────────────────────┘  │
│           ↑ Unix socket                  │
└───────────┬──────────────────────────────┘
            │
┌───────────▼──────────────────────────────┐
│  App A (Electron)                        │
│  vsql-micro/client (lightweight)         │
│  Just a socket client, no PG startup     │
└──────────────────────────────────────────┘
```

**Benefits:**
- Zero per-app startup (daemon already warm)
- One PG process per user (shared resources)
- Automatic connection pooling
- Familiar SQLite-like API

**Trade-offs:**
- First app pays startup cost
- Daemon lifecycle management
- Not truly "embedded"

---

### Option 3: Library Mode (Hardest, Cleanest)

```c
// vibesql-micro as a library, not binary
#include "vsql_micro.h"

int main() {
    vsql_micro_t* db = vsql_micro_open("./myapp.db");
    // PostgreSQL running in-process, no separate binary
}
```

```javascript
// Node.js native addon
const { Database } = require('vibesql-micro');

const db = new Database('./myapp.db');
// PostgreSQL as a library, linked into Node process
```

**Implementation:**
- Compile PostgreSQL as static library
- JNI/Node-API bindings
- Custom storage manager (single-file)

**Size target:** 10-15MB native addon

**Challenge:** PostgreSQL expects to be a server process, major refactoring needed

---

### Option 4: Fork-on-First-Query (Hybrid)

```javascript
import { Database } from 'vibesql-micro/lazy';

const db = new Database('./myapp.db');
// ← Returns immediately, no PG started yet

db.query('SELECT 1');
// ← First query triggers:
//     1. Fork vsql-micro process
//     2. Wait for ready (1-2s on first call)
//     3. Execute query
//     4. Keep warm for subsequent queries
```

**Benefits:**
- Instant API availability
- PG startup deferred until needed
- Keeps warm after first query

**Trade-offs:**
- First query is slow
- Still separate process

---

## Recommended: Hybrid Approach

### Phase 1: `--lazy-start` Flag (This Week)

```bash
vsql-micro ./myapp.db --lazy-start --http-port=auto
```

- Process starts instantly
- PG boots on first HTTP request
- Shows "warming up..." for 1-2 seconds
- Subsequent queries fast

### Phase 2: User-Wide Daemon (Next Month)

```bash
# One-time setup
vsql-micro install-daemon  # Starts on login

# Apps use client library (no startup)
vsql-micro client ./myapp.db
```

### Phase 3: WASM Experimental (Next Quarter)

Research project: PG in WASM for true embedded

---

## SQLite Parity Checklist

| SQLite Feature | vsql-micro Current | vsql-micro Target |
|----------------|-------------------|-------------------|
| `new Database('file.db')` | ❌ Spawn + wait | ✅ Instant |
| Single file | ❌ Data directory | ✅ Single file |
| No ports | ❌ TCP port | ✅ Unix socket or in-process |
| <5MB | ❌ 16-77MB | ✅ 5MB (daemon) or 8MB (WASM) |
| Zero config | ⚠️ CLI args | ✅ Sensible defaults |
| Sync API | ❌ HTTP only | ✅ Optional sync wrapper |

---

## What We Build Now

```javascript
// vibesql-micro/client - New package
import { createClient } from 'vibesql-micro/client';

const db = createClient('./myapp.db', {
  // Options
  lazyStart: true,        // Don't spawn PG until first query
  daemonMode: 'auto',     // Use daemon if available, else spawn
  cleanupOnExit: true,    // Shutdown PG when process exits
});

// SQLite-like API
db.exec(`CREATE TABLE logs (id SERIAL, msg TEXT)`);
const rows = db.query(`SELECT * FROM logs`);

// Or async/await
db.execAsync(`INSERT INTO logs (msg) VALUES (?)`, ['Hello']);
```

**Key innovation:** Client library handles all process management. User sees SQLite-like API, we handle the complexity.

---

## The Pitch

**For users:**
```javascript
// As easy as SQLite
import { createClient } from 'vibesql-micro/client';
const db = createClient('./app.db');
```

**But get PostgreSQL power:**
- JSONB queries
- Full-text search
- Time-series with BRIN indexes
- Same SQL as your cloud database

**Migration path:**
- SQLite app → vsql-micro (drop-in replacement)
- Local vsql-micro → Cloud VibeSQL (change URL only)
