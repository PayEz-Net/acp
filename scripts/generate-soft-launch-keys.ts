import * as fs from 'fs';
import * as path from 'path';
import { generateKey, normalizeKey, hashKey, keyPrefix } from '../api/keys/keyCodec.js';
import { insertKeys } from '../api/keys/storage.js';

function parseArgs(argv: string[]) {
  let count = 50;
  let tier = 'free_year';
  let expires = '';
  let out = './soft-launch-keys.csv';
  let dryRun = false;

  for (let i = 2; i < argv.length; i++) {
    switch (argv[i]) {
      case '--count':
        count = parseInt(argv[++i] || '50', 10);
        break;
      case '--tier':
        tier = argv[++i] || 'free_year';
        break;
      case '--expires':
        expires = argv[++i] || '';
        break;
      case '--out':
        out = argv[++i] || './soft-launch-keys.csv';
        break;
      case '--dry-run':
        dryRun = true;
        break;
    }
  }

  if (!expires) {
    const d = new Date();
    d.setFullYear(d.getFullYear() + 1);
    expires = d.toISOString().slice(0, 10); // YYYY-MM-DD
  }

  return { count, tier, expires, out, dryRun };
}

async function main() {
  const { count, expires, out, dryRun } = parseArgs(process.argv);

  console.log(`[batch] Generating ${count} key(s) — expires ${expires}${dryRun ? ' (DRY RUN)' : ''}`);

  const keys: string[] = [];
  const seen = new Set<string>();

  while (keys.length < count) {
    const key = generateKey();
    const normalized = normalizeKey(key);
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    keys.push(key);
  }

  const rows = keys.map((key) => ({
    key_hash: hashKey(normalizeKey(key)),
    key_prefix: keyPrefix(key),
    expires_at: `${expires}T00:00:00Z`,
  }));

  let inserted = 0;
  if (!dryRun) {
    try {
      inserted = await insertKeys(rows);
    } catch (err: any) {
      console.error('[batch] Insert failed:', err.message);
      process.exit(1);
    }
  }

  const csvLines = [
    '# DISTRIBUTION LIST — treat as secrets',
    'key,prefix,expires_at',
    ...keys.map((k, i) => `${k},${rows[i].key_prefix},${rows[i].expires_at}`),
  ];

  const outPath = path.resolve(out);
  fs.writeFileSync(outPath, csvLines.join('\n') + '\n', 'utf8');

  console.log(`[batch] ${dryRun ? 'Would insert' : 'Inserted'} ${inserted} new key(s)`);
  console.log(`[batch] CSV written to ${outPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
