#!/usr/bin/env node
/**
 * assert-env — build/release guard (WO #292).
 *
 * Confirms the baked src/main/env.generated.ts declares the EXPECTED env, so a
 * stale/mismatched generated file can never compile into the wrong artifact
 * (AC-9). The release pipeline runs `node scripts/assert-env.cjs prod` to refuse
 * shipping anything but a prod-baked public installer.
 *
 * Usage: node scripts/assert-env.cjs <expected-env>
 */
const fs = require('fs');
const path = require('path');

const expected = process.argv[2];
if (!expected) {
  console.error('[assert-env] FATAL: usage: node scripts/assert-env.cjs <expected-env>');
  process.exit(1);
}

const genPath = path.join(__dirname, '..', 'src', 'main', 'env.generated.ts');
if (!fs.existsSync(genPath)) {
  console.error(`[assert-env] FATAL: ${path.relative(path.join(__dirname, '..'), genPath)} does not exist — run gen-env first.`);
  process.exit(1);
}

const src = fs.readFileSync(genPath, 'utf8');
// Tolerate an optional type annotation (`ACP_ENV_NAME: string = "..."`).
const m = src.match(/ACP_ENV_NAME[^=]*=\s*"([^"]+)"/);
const baked = m && m[1];
if (baked !== expected) {
  console.error(
    `[assert-env] FATAL: baked env is '${baked}' but expected '${expected}'. ` +
    `Stale/mismatched env.generated.ts — refusing the build. Re-run gen-env for '${expected}'.`,
  );
  process.exit(1);
}

// Defense-in-depth for the prod release: no dev host may appear in the prod bake.
if (expected === 'prod' && /10\.0\.0\.93/.test(src)) {
  console.error(`[assert-env] FATAL: prod bake contains a dev host (127.0.0.1). Refusing.`);
  process.exit(1);
}

console.log(`[assert-env] OK — baked env is '${baked}'.`);
