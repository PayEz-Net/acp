# How SQLite Does It (And How We Get There)

## SQLite's Secret Sauce

### 1. In-Process Architecture
```c
// SQLite: Your process IS the database
int sqlite3_open(const char *filename, sqlite3 **ppDb);
// Database runs inside YOUR process space
```

**Why this matters:**
- No context switches
- No IPC overhead
- Shared memory (your heap = database cache)
- No "server" to manage

**PostgreSQL problem:** PG is architected as client/server. Rewriting to in-process = rewriting PostgreSQL.

### 2. Single-File Storage Format
```
sqlite> .open myapp.db
# That's it. One file.
```

**SQLite's B-tree design:**
- Everything in one file: tables, indexes, schema, WAL
- Locking via file-system advisory locks
- Page cache = mmap'd file

**PostgreSQL problem:** PG uses multi-file layout (tablespaces, WAL, config). Single-file requires custom storage manager.

### 3. Amalgamation Build
```
sqlite3.c    # Single 200k+ line C file
sqlite3.h    # Header
# That's the entire database engine
```

**Result:** Drop two files into any project. Compile. Done.

**PostgreSQL problem:** Millions of lines, complex build system, dependencies.

---

## Paths to "SQLite-Easy"

### Path A: The Hard Way (True Embedded PG)

**Goal:** PostgreSQL as a library, in-process

**Approach:**
```c
// What we want:
PGconn *pg = pg_embedded_open("myapp.pg");
// PostgreSQL runs in-process, single-file
```

**Blockers:**
1. PostgreSQL assumes multi-process (postmaster, backends)
2. Storage layer expects directory structure
3. Background writer, autovacuum assume separate processes
4. Signal handling, process isolation everywhere

**Effort:** 6-12 months, PG expert team

---

### Path B: The Clever Way (Process Pool)

**Insight:** What if startup isn't "starting PG" but "checking out a warm PG"?

```
┌─────────────────────────────────────────┐
│  VibeSQL Micro "Warm Pool" Daemon       │
│  (Started once, keeps PG processes warm)│
│  ┌─────────┐ ┌─────────┐ ┌─────────┐   │
│  │ PG Proc │ │ PG Proc │ │ PG Proc │   │
│  │ (idle)  │ │ (idle)  │ │ (idle)  │   │
│  └────┬────┘ └────┬────┘ └────┬────┘   │
│       └───────────┴───────────┘         │
│              Checkout on demand         │
└─────────────────────────────────────────┘
              ↑
┌─────────────┴───────────────────────────┐
│  App opens myapp.db                     │
│  ← Gets warm PG instantly (no boot)     │
└─────────────────────────────────────────┘
```

**Implementation:**
```bash
# System daemon (one per user)
vsql-micro warm-pool --size=3 --memory=100MB

# Apps connect instantly
vsql-micro use myapp.db  # ← No startup, just checkout
```

**Startup time:** 10-50ms (socket connection, not PG boot)

**Trade-off:** Not truly embedded, but feels like it.

---

### Path C: The Pragmatic Way (SQLite + PG Protocol)

**Crazy idea:** SQLite engine, PostgreSQL wire protocol

```
┌─────────────────────────────────────────┐
│  Your App                               │
│  ┌─────────────────────────────────┐   │
│  │  SQLite (engine)                │   │
│  │  - B-tree storage               │   │
│  │  - Zero config                  │   │
│  │  - Instant startup              │   │
│  └────────────┬────────────────────┘   │
│               │                         │
│  ┌────────────▼────────────────────┐   │
│  │  PG Protocol Layer              │   │
│  │  - Speaks PostgreSQL wire       │   │
│  │  - Translates to SQLite         │   │
│  │  - HTTP API (VibeSQL compat)    │   │
│  └─────────────────────────────────┘   │
└─────────────────────────────────────────┘
```

**Benefits:**
- SQLite ease (in-process, single-file)
- PostgreSQL API compatibility
- VibeSQL cloud compatibility

**Challenges:**
- SQL dialect differences (SQLite ≠ PostgreSQL)
- Type system mapping
- JSONB, arrays, advanced types

**Existing projects:**
- `pglite` (Electric SQL) - WASM PG, not SQLite
- `postgresqlite` - Does not exist yet

---

### Path D: The Compromise (Acceptable Trade-offs)

**What if we optimize the current approach to death?**

**Target:** 100ms startup, 5MB binary, single command

**Optimizations:**
1. **Pre-initialized data directory template**
   - Ship a "blank" PG data dir (pre-initialized)
   - Copy-on-write to user's location
   - Skip initdb (saves 1-2 seconds)

2. **Aggressive binary stripping**
   - Remove unused PG features (replication, SSL, etc.)
   - UPX compression
   - Target: 5-8MB

3. **Warm start protocol**
   - Keep PG parent process always running
   - Fork for each database (Copy-on-Write)
   - Similar to SQLite's in-process but with fork()

4. **Simplified storage**
   - Minimal WAL (just for crash recovery)
   - Single tablespace
   - No background processes (autovacuum off)

**Result:**
```bash
vsql-micro myapp.db  # 100ms startup, feels instant
```

---

## Recommendation: Path D + Path B Hybrid

### Phase 1: Optimize Current Approach (Path D)

```bash
# Target metrics
vsql-micro myapp.db
# Startup: <200ms
# Binary: <10MB
# Memory: <50MB
```

**Changes:**
1. Pre-initialized template (skip initdb)
2. Strip unused features
3. Disable background processes
4. Optimized defaults

### Phase 2: Warm Pool (Path B)

```bash
# Auto-daemon mode
vsql-micro myapp.db --daemon=auto
# First start: daemon launches (1-2s)
# Subsequent: instant checkout
```

**Daemon keeps pool of warm PGs:**
- User launches first app → daemon starts (one-time)
- App exits → PG returns to pool (reset state)
- Second app → instant checkout from pool

### Phase 3: Research Path C

Investigate SQLite-with-PG-protocol feasibility. Long-term bet.

---

## What We Build This Month

```javascript
// Client library that hides complexity
import { Database } from 'vibesql-micro/client';

const db = new Database('app.db', {
  // New options for "SQLite mode"
  template: 'minimal',     // Pre-initialized blank DB
  background: false,       // No autovacuum, bgwriter
  wal: 'minimal',          // Just crash recovery
  compression: true,       // UPX binary
});

// Feels like SQLite:
// - First call: 100-200ms (copy template, start PG)
// - Subsequent: <10ms (cached)
// - No process management for user
```

**The trick:** Make startup so fast users don't notice it's not in-process.

---

## SQLite Parity Scorecard

| Feature | SQLite | VibeSQL Micro Now | Target |
|---------|--------|-------------------|--------|
| Startup | 0ms | 2000ms | **200ms** |
| Binary | 1MB | 77MB | **10MB** |
| Single file | ✅ | ❌ | ✅ (template) |
| Zero config | ✅ | ❌ | **✅** |
| In-process | ✅ | ❌ | ❌ (acceptable) |
| SQL power | Basic | Full | Full |

**Acceptable trade-off:** Slight startup delay for full PostgreSQL power.

**Unacceptable:** Complex setup, multiple files, manual process management.

---

## The Real Answer

We can't make PostgreSQL truly "SQLite" without rewriting it. But we can get **close enough** that users don't care.

**Target experience:**
```javascript
const db = new Database('app.db');  // 200ms first time
// After that: instant

// Same as SQLite for 90% of use cases
// PostgreSQL power when needed
```

**That's the win.** Not perfect parity, but "close enough, with benefits."
