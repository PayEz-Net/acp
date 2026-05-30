# PG-Embedded: The Lore Build

## The Legend

**What if** you could have:
- SQLite ease (single file, zero config, instant)
- PostgreSQL power (JSONB, full SQL, transactions)
- **Virtual schemas** (dynamic, flexible, no migrations)

That's not just a product. That's **lore**.

---

## Virtual Schemas: The Core Differentiator

### What Makes It Special

**SQLite:** Fixed schema, rigid tables
```sql
-- SQLite: Plan ahead or ALTER TABLE
CREATE TABLE users (id INTEGER, name TEXT, email TEXT);
-- Oops, need to add phone? ALTER TABLE...
```

**PostgreSQL:** Flexible with JSONB, but complex
```sql
-- PostgreSQL: Powerful but verbose
CREATE TABLE users (id SERIAL, data JSONB);
CREATE INDEX ON users USING GIN ((data->'tags'));
-- Need validation? Write triggers or use constraints...
```

**PG-Embedded with Virtual Schemas:**
```javascript
const db = new Database('app.pg');

// Schema defined inline, validated automatically
db.createCollection('users', {
  schema: {
    id: 'serial',
    name: { type: 'text', required: true },
    email: { type: 'text', validate: 'email' },
    profile: {
      type: 'object',
      properties: {
        age: 'integer',
        tags: { type: 'array', items: 'text' }
      }
    },
    metadata: 'jsonb'  // Flexible bag of stuff
  },
  indexes: [
    { fields: ['email'], unique: true },
    { fields: ['profile.tags'], type: 'gin' }
  ]
});

// Insert - schema validated automatically
db.insert('users', {
  name: 'Alice',
  email: 'alice@example.com',
  profile: { age: 30, tags: ['developer', 'postgres'] },
  metadata: { source: 'signup', campaign: 'lore' }
});

// Query with JSONB power
db.query(`
  SELECT * FROM users 
  WHERE profile @> '{"tags": ["developer"]}'
  AND metadata->>'source' = 'signup'
`);

// Schema evolves without migration
db.evolveSchema('users', {
  add: { phone: { type: 'text' } },
  remove: ['old_field']
});
```

### Why This Is Lore

| Product | Ease | Power | Virtual Schemas |
|---------|------|-------|-----------------|
| SQLite | ✅ | ❌ | ❌ |
| PostgreSQL | ❌ | ✅ | ⚠️ (manual) |
| MongoDB | ✅ | ⚠️ | ✅ (no SQL) |
| Supabase | ⚠️ | ✅ | ⚠️ (hosted) |
| **PG-Embedded** | ✅ | ✅ | ✅ |

**No one has all three.**

---

## Architecture: Virtual Schemas + Embedded

### Storage Layer

```c
// Single file: app.pg
typedef struct PgEmbeddedFile {
    // Header
    PgHeader header;
    
    // Schema catalog (virtual schemas stored here)
    PgSchemaCatalog schemas;
    
    // Data pages (PostgreSQL format)
    PgPage data[];
    
    // WAL (circular buffer)
    PgWal wal;
} PgEmbeddedFile;

// Virtual schema storage
typedef struct VirtualSchema {
    char name[NAMEDATALEN];
    Jsonb schema_def;           // JSON schema definition
    Jsonb validation_rules;     // Custom validations
    Oid table_oid;              // Underlying PostgreSQL table
    VirtualIndex indexes[];     // Virtual index definitions
} VirtualSchema;
```

### Schema Validation Engine

```c
// In-process, no overhead
typedef struct SchemaValidator {
    VirtualSchema *schema;
    JsonbValidator *json_validator;
} SchemaValidator;

bool pg_validate_insert(SchemaValidator *validator, 
                        Jsonb *data, 
                        char **error_msg) {
    // Fast validation against virtual schema
    // No SQL parsing, direct C validation
    
    // Check required fields
    // Check types
    // Run custom validators
    // Return detailed error
}

// Example: Email validation
bool validate_email(const char *value) {
    // Fast regex, no SQL overhead
    return regex_match(value, EMAIL_PATTERN);
}
```

### Query Translation

```sql
-- Virtual schema query (what user writes)
SELECT * FROM users 
WHERE profile.age > 25 
AND tags @> '["developer"]';

-- Translated to PostgreSQL (behind the scenes)
SELECT * FROM users 
WHERE data->'profile'->>'age'::int > 25
AND data->'tags' @> '["developer"]'::jsonb;
```

**The magic:** User writes clean queries, we handle JSONB paths.

---

## The Developer Experience

### As Easy As SQLite

```javascript
// 1. npm install
npm install pg-embedded

// 2. One file, zero config
const { Database } = require('pg-embedded');
const db = new Database('myapp.pg');  // ← Just works

// 3. Schema on first write (no migrations!)
db.collection('posts').insert({
  title: 'Hello World',
  tags: ['postgres', 'lore'],
  views: 0
});
// Schema inferred and created automatically

// 4. Query with full SQL power
const posts = db.query(`
  SELECT title, tags 
  FROM posts 
  WHERE views > 100 
  ORDER BY created_at DESC
`);
```

### But PostgreSQL Underneath

```javascript
// Full SQL support
const result = db.query(`
  WITH popular_posts AS (
    SELECT *, views / EXTRACT(DAYS FROM (NOW() - created_at)) as velocity
    FROM posts
    WHERE views > 1000
  )
  SELECT 
    p.title,
    p.velocity,
    COUNT(c.id) as comment_count
  FROM popular_posts p
  LEFT JOIN comments c ON c.post_id = p.id
  GROUP BY p.id
  HAVING COUNT(c.id) > 10
  ORDER BY p.velocity DESC
  LIMIT 10
`);

// Transactions
const tx = db.begin();
try {
  tx.query('UPDATE accounts SET balance = balance - 100 WHERE id = 1');
  tx.query('UPDATE accounts SET balance = balance + 100 WHERE id = 2');
  tx.commit();
} catch (err) {
  tx.rollback();
}

// JSONB deep queries
db.query(`
  SELECT * FROM events
  WHERE payload @> '{
    "user": {
      "subscription": "premium"
    }
  }'
  AND created_at > NOW() - INTERVAL '7 days'
`);
```

### Virtual Schema Evolution

```javascript
// No migrations needed!

// Start simple
db.collection('users').insert({ name: 'Alice' });

// Add fields later
db.collection('users').insert({ 
  name: 'Bob', 
  email: 'bob@example.com',
  preferences: { theme: 'dark' }
});
// Schema automatically evolved

// Enforce schema when ready
db.collection('users').enforceSchema({
  name: { type: 'text', required: true },
  email: { type: 'text', validate: 'email' }
});

// Query old and new data seamlessly
const users = db.query('SELECT * FROM users');
// Returns both Alice (no email) and Bob (with email)
```

---

## The Lore Stories

### Story 1: The Indie Developer

> "I built an app with SQLite. Hit wall with complex queries. 
> Looked at PostgreSQL - too heavy for desktop app.
> Found PG-Embedded. Single file like SQLite. 
> But then I needed full-text search on JSON... worked instantly.
> That's when I knew this was different."

### Story 2: The Enterprise Team

> "We have edge devices in factories. Need local database.
> SQLite couldn't handle our query complexity.
> PostgreSQL too heavy to deploy on 10,000 devices.
> PG-Embedded: 5MB binary, full SQL, virtual schemas.
> Deployed in a week."

### Story 3: The Startup Pivot

> "Started with MongoDB for flexibility. Hit scaling issues.
> Migrated to PostgreSQL. Migration took 3 months.
> Should have used PG-Embedded from start.
> Same flexibility, scales to cloud PostgreSQL when ready."

---

## Competitive Moat

### What Makes It Defensible

1. **Technical:** In-process PostgreSQL is hard
2. **Virtual Schemas:** Unique feature, not in SQLite
3. **Compatibility:** Cloud PostgreSQL migration path
4. **Lore:** Being "the SQLite with PostgreSQL power"

### Who Can't Copy This Easily

| Competitor | Why They Can't |
|------------|---------------|
| SQLite | Can't add PostgreSQL features |
| PostgreSQL | Can't become embeddable easily |
| MongoDB | No SQL heritage |
| Firebird | Different architecture |
| DuckDB | Analytics focus, no virtual schemas |

---

## The Tagline

**"PG-Embedded: PostgreSQL power, SQLite ease, virtual schema freedom."**

Or:

**"The database that shouldn't exist, but does."**

Or:

**"Lore in a 5MB binary."**

---

## Call to Action

This is the build. This is the lore.

**PG-Embedded with virtual schemas.**

Single file. Zero config. Full PostgreSQL. Dynamic schemas.

Nobody has this. We build it, we own the category.
