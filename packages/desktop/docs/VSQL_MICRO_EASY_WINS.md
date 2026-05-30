# Making VibeSQL Micro "SQLite-Easy" - Concrete Wins

## Current Pain vs SQLite

| SQLite | VibeSQL Micro Today |
|--------|---------------------|
| `npm install better-sqlite3` | Find binary, download, place in PATH |
| `new Database('app.db')` | Spawn process, manage lifecycle, handle crashes |
| Works instantly | 1-3 second PostgreSQL boot |
| One file | Data directory, config files |
| No thinking | Port conflicts, permissions, cleanup |

## The Easy Wins (Do These First)

### 1. Zero-Config Client Library

```javascript
// Current (painful)
import { spawn } from 'child_process';
import waitOn from 'wait-on';

const proc = spawn('vibesql-micro', ['--data-dir', './data', '--port', '5433']);
await waitOn({ resources: ['tcp:5433'] });
// ... error handling, cleanup, port conflicts ...
```

```javascript
// Target (SQLite-easy)
import { Database } from 'vibesql-micro/client';

const db = new Database('app.db');  // ← Just works
```

**Implementation:**
```typescript
// vibesql-micro/client
export class Database {
  private proc: ChildProcess | null = null;
  private port: number = 0;
  
  constructor(path: string, opts?: Options) {
    // 1. Find free port automatically
    this.port = findFreePort();
    
    // 2. Find vibesql-micro binary (bundled, PATH, or download)
    const binary = findBinary();
    
    // 3. Spawn with sensible defaults
    this.proc = spawn(binary, [
      '--data-dir', path,
      '--http-port', this.port.toString(),
      '--quiet',           // No stdout spam
      '--auto-shutdown',   // Die when parent dies
    ]);
    
    // 4. Wait for ready (with timeout, clear error)
    await waitForReady(this.port, { timeout: 5000 });
  }
  
  query(sql: string, params?: any[]) {
    return fetch(`http://localhost:${this.port}/v1/query`, {
      method: 'POST',
      body: JSON.stringify({ sql, params })
    }).then(r => r.json());
  }
  
  // Auto-cleanup on process exit
  close() {
    this.proc?.kill();
  }
}
```

### 2. Sensible Defaults (No Config Needed)

```javascript
// SQLite: Just a filename
new Database('myapp.db')

// VibeSQL Micro: Should be the same
new Database('myapp.db')  // ← Creates myapp.db/ automatically

// Options ONLY when needed
new Database('myapp.db', {
  port: 5433,        // Auto if not specified
  memory: '100MB',   // Sensible default
  wal: true,         // On by default
})
```

### 3. Single-File Storage (Not Directory)

**Current:**
```
myapp.db/
├── base/
├── global/
├── pg_wal/
├── postgresql.conf
└── ... 20+ files
```

**Target:**
```
myapp.db          # ← One file (like SQLite)
myapp.db.wal      # ← WAL file (auto-managed)
```

**Implementation:** PostgreSQL tablespace in single file via:
- Custom tablespace on flat file
- Or: Bundle directory, expose as single file via FUSE (overkill)
- Or: Accept directory, but hide it (`.myapp.db/` hidden dir)

**Easiest:** Auto-create hidden directory
```javascript
new Database('myapp.db')
// Creates: .myapp.db.vsql/ (hidden from user)
// User sees: just their code
```

### 4. Clear Error Messages

**Current (PostgreSQL errors):**
```
could not bind IPv4 socket: Address already in use
Is another postmaster already running on port 5432?
```

**Target (Human errors):**
```
VibeSQL Micro: Port 5432 is already in use.

Try:
  1. Use a different port: new Database('app.db', { port: 0 })  // auto
  2. Kill existing process: vibesql-micro stop
  3. Check what's using port 5432: lsof -i :5432
```

### 5. Bundle the Binary

**Current:** User downloads separate binary

**Target:** npm install includes binary

```json
// package.json
{
  "optionalDependencies": {
    "vibesql-micro-win32-x64": "^1.0.0",
    "vibesql-micro-darwin-x64": "^1.0.0",
    "vibesql-micro-linux-x64": "^1.0.0"
  }
}
```

```javascript
// client finds bundled binary automatically
function findBinary() {
  // 1. Check node_modules/vibesql-micro-*/bin/
  // 2. Check PATH
  // 3. Download on first use (optional)
}
```

### 6. First-Query Warmup (Lazy Start)

```javascript
const db = new Database('app.db', { lazy: true });
// ← Returns instantly, no PG started

await db.query('SELECT 1');
// ← First query: "Starting VibeSQL Micro..." (1-2s)
// ← Subsequent queries: instant
```

**Benefit:** App startup isn't blocked by PG boot

### 7. Auto-Cleanup (No Zombie Processes)

```javascript
// Parent dies → PG dies automatically
process.on('exit', () => db.close());
process.on('SIGINT', () => db.close());
process.on('SIGTERM', () => db.close());

// Or: --auto-shutdown flag in vibesql-micro
// Watches parent PID, dies when parent dies
```

### 8. SQLite-Compatible API

```javascript
import { Database } from 'vibesql-micro/client';

const db = new Database('app.db');

// SQLite-style API (familiar)
db.exec('CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)');

const stmt = db.prepare('INSERT INTO users (name) VALUES (?)');
stmt.run('Alice');
stmt.run('Bob');

const rows = db.prepare('SELECT * FROM users').all();
console.log(rows); // [{ id: 1, name: 'Alice' }, ...]

// But ALSO get VibeSQL features:
const json = db.prepare(`
  SELECT * FROM users 
  WHERE metadata @> '{"premium": true}'
`).all();
```

### 9. Clear Documentation (Simple First)

**Current docs:** Start with CLI flags, config options, server modes

**Target docs:**
```markdown
# Quick Start

```bash
npm install vibesql-micro
```

```javascript
const { Database } = require('vibesql-micro');

const db = new Database('app.db');
db.exec('CREATE TABLE logs (msg TEXT)');
db.prepare('INSERT INTO logs VALUES (?)').run('Hello');
```

**That's it.** PostgreSQL power, SQLite ease.

---

## Implementation Priority

| # | Feature | Effort | Impact |
|---|---------|--------|--------|
| 1 | Client library with auto-discovery | Medium | **HIGH** |
| 2 | Sensible defaults (auto port, hidden dir) | Low | **HIGH** |
| 3 | Better error messages | Low | Medium |
| 4 | Bundle binary in npm | Medium | **HIGH** |
| 5 | Lazy start option | Low | Medium |
| 6 | Auto-cleanup | Low | Medium |
| 7 | SQLite-compatible API wrapper | Medium | **HIGH** |
| 8 | Single-file storage (hard) | High | Low |

## The 80/20

Do #1, #2, #4, #7 → Get 80% of "SQLite-easy" with 20% effort.

```javascript
// After these 4 changes:
import { Database } from 'vibesql-micro';  // Bundled, auto-discovery

const db = new Database('app.db');           // Auto-port, hidden storage
db.exec('CREATE TABLE ...');                 // SQLite API
db.query('SELECT ...');                      // Returns Promise

// User experience: Comparable to SQLite
// Underneath: Full PostgreSQL
```

## Next Step

Build the client library (`vibesql-micro/client`) that:
1. Auto-finds bundled binary
2. Auto-assigns port
3. Handles spawn/cleanup
4. Wraps in SQLite-like API

**This is the "easy" we need.**
