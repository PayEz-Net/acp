#!/usr/bin/env tsx
// ACP Agent Chat — Schema migration script
// Usage: npx tsx chat/migrate.ts

import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ChatPersistence, VibeQueryClient } from './persistence.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

async function main() {
  const vibesqlUrl = process.env.VIBESQL_DIRECT_URL || process.env.VIBESQL_URL || 'http://localhost:5173';
  const schemaPath = resolve(__dirname, 'schema.sql');

  console.log(`[migrate] VibeSQL endpoint: ${vibesqlUrl}`);
  console.log(`[migrate] Schema file: ${schemaPath}`);

  const db = new VibeQueryClient({ vibesqlDirectUrl: vibesqlUrl });
  const persistence = new ChatPersistence(db);

  console.log('[migrate] Running schema migration...');
  const result = await persistence.runMigration(schemaPath);

  console.log(`[migrate] Total statements: ${result.total}`);
  console.log(`[migrate] Succeeded: ${result.succeeded}`);

  if (result.failed.length > 0) {
    console.error(`[migrate] Failed (${result.failed.length}):`);
    for (const msg of result.failed) {
      console.error(`  - ${msg}`);
    }
    process.exit(1);
  }

  // Verify tables exist
  console.log('[migrate] Verifying tables...');
  const verify = await db.query(
    `SELECT table_name FROM information_schema.tables WHERE table_name LIKE 'acp_%' ORDER BY table_name`
  );
  const tables = (verify.rows || []).map(r => r.table_name);
  console.log(`[migrate] Found ${tables.length} acp_ tables: ${tables.join(', ')}`);

  const expected = [
    'acp_attachments', 'acp_conversation_participants', 'acp_conversations',
    'acp_delivery', 'acp_messages', 'acp_reactions',
    'acp_thread_subscriptions', 'acp_threads',
  ];
  const missing = expected.filter(t => !tables.includes(t));
  if (missing.length > 0) {
    console.error(`[migrate] Missing tables: ${missing.join(', ')}`);
    process.exit(1);
  }

  console.log('[migrate] Migration complete. All tables verified.');
}

main().catch(err => {
  console.error('[migrate] Fatal error:', err.message || err);
  process.exit(1);
});
