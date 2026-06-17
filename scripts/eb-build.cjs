#!/usr/bin/env node
/**
 * eb-build — run electron-builder with an env-derived installer-name suffix.
 *
 * Jon's requirement: when the ACP installer is built pointed at 93, the installer
 * file MUST carry a `_93` suffix (e.g. "ACP Setup 0.1.0_93.exe"); the prod installer
 * is named as-is ("ACP Setup 0.1.0.exe"). So you can never confuse the two artifacts.
 *
 * SAFETY (the load-bearing bit): the suffix is derived from the env that was ACTUALLY
 * BAKED into this build — read from src/main/env.generated.ts's ACP_ENV_NAME (which
 * gen-env.cjs wrote for THIS build) — NOT from a CLI flag. So the installer NAME can
 * never drift from its baked env: a dev93-baked build is ALWAYS named _93, a prod build
 * is ALWAYS clean. Name-from-bake, not name-from-argument.
 *
 * Pairs with package.json build.nsis/portable.artifactName, which reference
 * ${env.ACP_ARTIFACT_SUFFIX} (this script sets it before spawning electron-builder).
 * Any extra args (e.g. --win) pass straight through to electron-builder.
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const genPath = path.join(__dirname, '..', 'src', 'main', 'env.generated.ts');
let src;
try {
  src = fs.readFileSync(genPath, 'utf8');
} catch {
  console.error(
    `[eb-build] FATAL: ${genPath} not found. The build chain must run gen-env (npm run gen-env:prod | gen-env:93) BEFORE eb-build, so the baked env exists.`,
  );
  process.exit(1);
}

const m = src.match(/ACP_ENV_NAME[^"']*["']([^"']+)["']/);
if (!m) {
  console.error('[eb-build] FATAL: could not read ACP_ENV_NAME from env.generated.ts. Refusing to name an installer with an unknown env.');
  process.exit(1);
}
const envName = m[1];

let suffix;
if (envName === 'prod') {
  suffix = '';
} else if (envName === 'dev93') {
  suffix = '_93';
} else {
  console.error(`[eb-build] FATAL: unknown baked env '${envName}' — no naming rule. (Known: prod -> '', dev93 -> '_93'.)`);
  process.exit(1);
}

console.log(`[eb-build] baked ACP_ENV_NAME='${envName}' -> installer suffix='${suffix || '(none — prod)'}'`);

const passthrough = process.argv.slice(2); // e.g. --win / --mac / --linux
const child = spawnSync('electron-builder', passthrough, {
  stdio: 'inherit',
  shell: true,
  env: { ...process.env, ACP_ARTIFACT_SUFFIX: suffix },
});
process.exit(child.status === null ? 1 : child.status);
