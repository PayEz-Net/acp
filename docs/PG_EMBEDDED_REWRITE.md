# PG-Embedded: PostgreSQL Rebuilt for Desktop

## The Premise

**Goal:** PostgreSQL-compatible SQL, SQLite-like architecture

**Result:** `pg-embedded` - single binary, in-process, single-file database

---

## Core Architecture Changes

### 1. In-Process Execution Model

**Current PostgreSQL:**
```
Postmaster (parent)
├── Backend 1 (client connection)
├── Backend 2 (client connection)
├── Background Writer
├── WAL Writer
├── Autovacuum Launcher
└── Stats Collector
```

**PG-Embedded:**
```
Your Application Process
└── PG Engine (linked library)
    ├── SQL Parser
    ├── Query Planner
    ├── Executor
    └── Storage Engine (B-tree)
```

**Key Changes:**
- Remove all `fork()` calls
- Remove all inter-process communication
- Shared memory → Your process heap
- Backend processes → Function calls

### 2. Single-File Storage Format

**Current PostgreSQL:**
```
data/
├── base/           # Database files (per table)
├── global/         # Global catalogs
├── pg_wal/         # Write-ahead log
├── pg_xact/        # Transaction status
└── postgresql.conf # Settings
```

**PG-Embedded (SQLite-style):**
```
myapp.pg          # One file
├── Header (page 0)
│   ├── Magic number
│   ├── Version
│   └── Root page pointers
├── B-tree Pages
│   ├── Table data
│   ├── Indexes
│   └── Free list
└── WAL (circular buffer at end)
```

**Storage Format:**
```c
// Page structure (8KB like PG, but unified)
typedef struct PageHeader {
    uint16 pd_checksum;     // Page checksum
    uint16 pd_flags;        // Flags (leaf, internal, etc)
    uint16 pd_lower;        // Offset to free space
    uint16 pd_upper;        // Offset to end of free space
    uint16 pd_special;      // Offset to special space
    uint16 pd_pagesize_version;
    ItemIdData pd_linp[0];  // Line pointers (tuple offsets)
} PageHeader;

// Page types (same as PG)
#define PG_HEAP_PAGE      0x01  // Table data
#define PG_INDEX_PAGE     0x02  // B-tree index
#define PG_WAL_PAGE       0x04  // WAL records
#define PG_META_PAGE      0x08  // Metadata/catalogs
```

### 3. Cooperative Multitasking (No Processes)

**Current PostgreSQL:**
```c
// Each connection gets a backend process
pid = fork();
if (pid == 0) {
    // Backend process handles one connection
    handle_connection(client);
}
```

**PG-Embedded:**
```c
// Single-threaded or thread-pool (your choice)
typedef struct PgConnection {
    MemoryContext context;
    TransactionState xact_state;
    QueryEnvironment query_env;
    // No process, just state
} PgConnection;

// Open database (in your process)
PgConn *pg_open(const char *filename) {
    PgDatabase *db = mmap_database(filename);
    PgConn *conn = create_connection(db);
    return conn;
}

// Execute query (function call, not IPC)
PgResult *pg_exec(PgConn *conn, const char *sql) {
    // All happens in YOUR thread
    List *parsetree = pg_parse_sql(sql);
    PlannedStmt *plan = pg_planner(parsetree);
    return pg_executor(plan);
}
```

### 4. Locking Model (File-Based, Not Multi-Process)

**Current PostgreSQL:**
```c
// Heavyweight locks, LWLocks, spinlocks
// Between processes via shared memory
```

**PG-Embedded (SQLite-style):**
```c
// POSIX advisory file locks (flock)
// or Windows file locking

typedef struct PgLock {
    int fd;                    // Database file descriptor
    pg_lock_mode mode;         // SHARED, RESERVED, PENDING, EXCLUSIVE
} PgLock;

void pg_lock(PgLock *lock, pg_lock_mode mode) {
    // Standard file locking
    flock(lock->fd, mode == PG_LOCK_EXCLUSIVE ? LOCK_EX : LOCK_SH);
}

// Page-level locking (for concurrency within process)
typedef struct PageLock {
    uint32 page_num;
    pg_lock_mode mode;
    struct PageLock *next;
} PageLock;

// In-process lock manager (no IPC needed)
static PageLock *active_locks = NULL;

void pg_lock_page(uint32 page_num, pg_lock_mode mode) {
    // Simple hash table of page locks
    // No IPC because we're single-process
}
```

### 5. WAL Simplification

**Current PostgreSQL:**
```
Separate WAL writer process
Complex checkpoint logic
Multi-file WAL segments
```

**PG-Embedded:**
```c
// WAL as circular buffer at end of database file
// Or: Separate .wal file (but simpler than PG)

typedef struct PgWal {
    int fd;                    // WAL file descriptor
    uint64 write_pos;          // Current write position
    uint64 flush_pos;          // Last fsync position
    PgWalRecord *buffer;       // In-memory buffer
} PgWal;

void pg_wal_insert(PgWal *wal, PgWalRecord *record) {
    // Append to in-memory buffer
    memcpy(wal->buffer + wal->write_pos, record, record->size);
    wal->write_pos += record->size;
    
    // Optional: fsync (can be disabled for logs)
    if (wal->need_fsync) {
        pwrite(wal->fd, record, record->size, wal->flush_pos);
        fdatasync(wal->fd);
        wal->flush_pos = wal->write_pos;
    }
}

// Recovery: Simple replay
void pg_wal_replay(PgDatabase *db, PgWal *wal) {
    // Read records from WAL
    // Apply to database pages
    // Checkpoint when caught up
}
```

### 6. Storage Manager (B-Tree Based)

**Reuse SQLite's approach but with PostgreSQL's page format:**

```c
// B-tree navigation (like SQLite, PG compatible)
typedef struct BtCursor {
    PgDatabase *db;
    uint32 root_page;
    uint32 current_page;
    uint16 current_cell;
} BtCursor;

int bt_move_to(BtCursor *cursor, Datum key) {
    // Traverse B-tree
    // Pages are PostgreSQL format
    // But navigation is SQLite-style
}

int bt_insert(BtCursor *cursor, Datum key, Datum value) {
    // Find leaf page
    // Insert cell
    // Split if needed
    // Update parent pointers
}
```

### 7. Memory Management

**Current PostgreSQL:**
```c
// Complex memory contexts
// Shared memory segments
// Process-local allocations
```

**PG-Embedded:**
```c
// Simple arenas (like SQLite)
typedef struct PgArena {
    char *base;
    size_t size;
    size_t used;
} PgArena;

void *pg_alloc(PgArena *arena, size_t size) {
    void *ptr = arena->base + arena->used;
    arena->used += size;
    return ptr;
}

// Per-query arena - freed all at once
// Per-connection arena - survives across queries
// No complex context switching
```

---

## Implementation Strategy

### Phase 1: Parser + Planner (Reuse)

**Can reuse from PostgreSQL:**
- SQL parser (`src/backend/parser/`)
- Query planner (`src/backend/optimizer/`)
- Catalog definitions (`src/include/catalog/`)

**Strip out:**
- Client/server protocol handling
- Process management
- Signal handling
- Multi-process locking

### Phase 2: Executor (Adapt)

**Reuse:**
- Node types (`src/backend/executor/`)
- Expression evaluation
- Function implementations

**Modify:**
- Storage access (B-tree instead of heapam)
- Locking (file-based instead of multi-process)
- Transaction management (simpler, single-process)

### Phase 3: Storage Engine (New)

**Build new:**
```c
// src/storage/pg_embedded_storage.c

PgDatabase *pg_storage_open(const char *filename);
void pg_storage_close(PgDatabase *db);

Page pg_read_page(PgDatabase *db, uint32 page_num);
void pg_write_page(PgDatabase *db, uint32 page_num, Page page);

// B-tree operations
uint32 bt_create(PgDatabase *db);
bool bt_insert(PgDatabase *db, uint32 root_page, Datum key, Datum value);
bool bt_search(PgDatabase *db, uint32 root_page, Datum key, Datum *value);
```

### Phase 4: WAL + Recovery (Simplify)

```c
// src/storage/pg_embedded_wal.c

// Simple ARIES-style logging, but single-process
void pg_log_insert(PgDatabase *db, Page page, OffsetNumber offnum, HeapTuple tuple);
void pg_log_delete(PgDatabase *db, Page page, OffsetNumber offnum);
void pg_log_update(PgDatabase *db, Page page, OffsetNumber offnum, HeapTuple new_tuple);

// Recovery
void pg_recover(PgDatabase *db);
```

---

## API Design

### C API (Like SQLite)

```c
#include "pg_embedded.h"

// Open database (creates if not exists)
PgDB *db = pg_open("myapp.pg", PG_OPEN_CREATE);

// Execute SQL
PgResult *result = pg_exec(db, "CREATE TABLE users (id SERIAL PRIMARY KEY, name TEXT)");
pg_result_free(result);

// Prepared statements
PgStmt *stmt = pg_prepare(db, "INSERT INTO users (name) VALUES ($1)");
pg_bind_text(stmt, 1, "Alice");
pg_step(stmt);
pg_reset(stmt);

pg_bind_text(stmt, 1, "Bob");
pg_step(stmt);

// Query
PgResult *users = pg_exec(db, "SELECT * FROM users");
for (int i = 0; i < pg_row_count(users); i++) {
    int id = pg_column_int(users, i, 0);
    const char *name = pg_column_text(users, i, 1);
    printf("%d: %s\n", id, name);
}
pg_result_free(users);

// Cleanup
pg_finalize(stmt);
pg_close(db);
```

### Node.js API

```javascript
const { Database } = require('pg-embedded');

const db = new Database('myapp.pg');

db.exec(`
  CREATE TABLE logs (
    id SERIAL PRIMARY KEY,
    level TEXT,
    msg TEXT,
    metadata JSONB
  )
`);

const stmt = db.prepare('INSERT INTO logs (level, msg, metadata) VALUES (?, ?, ?)');
stmt.run('INFO', 'Server started', { port: 3000 });
stmt.run('ERROR', 'Connection failed', { retry: 3 });

// JSONB queries work!
const errors = db.query(`
  SELECT * FROM logs 
  WHERE level = 'ERROR' 
  AND metadata @> '{"retry": 3}'
`);
```

---

## PostgreSQL Compatibility

### What We Keep

- SQL syntax (parser reuse)
- Data types (int, text, jsonb, array, etc.)
- Operators and functions
- Index types (B-tree, hash, GiST concepts)
- Transaction semantics (ACID)
- Catalog structure

### What We Simplify

| Feature | PostgreSQL | PG-Embedded |
|---------|-----------|-------------|
| Concurrency | Multi-process | Single-process, file locks |
| Replication | Streaming, logical | None (embedded) |
| Partitioning | Complex | Simplified |
| Extensions | C shared libs | Built-in or WASM |
| Authentication | Complex | None (in-process) |
| Configuration | 200+ params | Sensible defaults |

---

## Size Estimates

| Component | Lines of Code | Estimated Binary |
|-----------|--------------|------------------|
| Parser (reuse) | ~50K | Included |
| Planner (reuse) | ~80K | Included |
| Executor (adapt) | ~60K | Included |
| Storage (new) | ~20K | Included |
| WAL (simplify) | ~10K | Included |
| Catalogs (reuse) | ~30K | Included |
| **Total** | **~250K** | **~3-5MB stripped** |

**Compare:**
- SQLite: ~200K LOC, 1MB
- PostgreSQL: ~1M LOC, 20MB+
- PG-Embedded: ~250K LOC, 3-5MB

---

## Timeline Estimate

| Phase | Duration | Deliverable |
|-------|----------|-------------|
| 1: Parser/Planner isolation | 2 weeks | Compile without backend |
| 2: Storage engine | 4 weeks | B-tree, single-file format |
| 3: Executor adaptation | 3 weeks | Works with new storage |
| 4: WAL + Recovery | 2 weeks | Crash recovery |
| 5: Integration + Tests | 3 weeks | Working prototype |
| **Total** | **14 weeks** | **MVP** |

Team: 2-3 senior C developers

---

## The Pitch

**PG-Embedded:** PostgreSQL power, SQLite ease

```javascript
const db = require('pg-embedded');

// As easy as SQLite
const conn = db.open('app.pg');

// But PostgreSQL power
conn.exec(`
  CREATE TABLE events (
    id SERIAL,
    data JSONB,
    created_at TIMESTAMPTZ DEFAULT NOW()
  )
`);

conn.exec(`
  SELECT * FROM events 
  WHERE data @> '{"type": "error"}'
  AND created_at > NOW() - INTERVAL '1 hour'
`);
```

**Use cases:**
- Desktop apps (Electron, Tauri)
- Mobile apps (via bindings)
- CLI tools
- Testing (same SQL as production)
- Edge computing

**Competitive advantage:**
- SQLite: Easy, limited SQL
- PostgreSQL: Powerful, complex setup
- PG-Embedded: Both

---

## Risk Assessment

| Risk | Mitigation |
|------|-----------|
| Too much work | Start with parser reuse, incremental |
| PG compatibility | Test suite from PostgreSQL |
| Performance | Benchmark early, optimize storage |
| Maintenance | Keep close to PG source for updates |

**Biggest risk:** It's a lot of work. But the payoff is huge.
