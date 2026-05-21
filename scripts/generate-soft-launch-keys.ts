import * as fs from 'fs';
import * as path from 'path';
import { generateKey, normalizeKey, hashKey, keyPrefix } from '../api/keys/keyCodec.js';
import { insertKeys } from '../api/keys/storage.js';
import { config } from '../config.js';

function parseArgs(argv: string[]) {
  let count = 50;
  let tier = 'free_year';
  let expires = '';
  let out = '';
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
        out = argv[++i] || '';
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

  // Default output outside repo root with .gitignore guard
  if (!out) {
    const home = process.env.HOME || process.env.USERPROFILE || process.cwd();
    out = path.join(home, 'acp-soft-launch-keys.csv');
  }

  return { count, tier, expires, out, dryRun };
}

function isInsideGitRepo(p: string): boolean {
  let dir = path.dirname(path.resolve(p));
  const root = path.parse(dir).root;
  while (dir !== root) {
    if (fs.existsSync(path.join(dir, '.git'))) return true;
    dir = path.dirname(dir);
  }
  return false;
}

async function main() {
  const { count, expires, out, dryRun } = parseArgs(process.argv);

  console.log(`[batch] Generating ${count} key(s) — expires ${expires}${dryRun ? ' (DRY RUN)' : ''}`);

  const pepper = config.licenseKeyPepper || process.env.LICENSE_KEY_PEPPER;
  if (!pepper) {
    console.error('[batch] LICENSE_KEY_PEPPER is not set. Set it in .env or export before running.');
    process.exit(1);
  }

  if (!dryRun && isInsideGitRepo(out)) {
    console.error('[batch] Refusing to write inside a git working tree. Use --out <path-outside-repo> or run from outside the repo.');
    process.exit(1);
  }

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
    key_hash: hashKey(normalizeKey(key), pepper),
    key_prefix: keyPrefix(key),
    expires_at: `${expires}T00:00:00Z`,
    hash_version: 'v1',
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
    '# DISTRIBUTION LIST — treat as secrets. Delete after distribution.',
    'key,prefix,expires_at',
    ...keys.map((k, i) => `${k},${rows[i].key_prefix},${rows[i].expires_at}`),
  ];

  const outPath = path.resolve(out);
  fs.writeFileSync(outPath, csvLines.join('\n') + '\n', { encoding: 'utf8', mode: 0o600 });

  console.log(`[batch] ${dryRun ? 'Would insert' : 'Inserted'} ${inserted} new key(s)`);
  console.log(`[batch] CSV written to ${outPath} (perms 0600)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
