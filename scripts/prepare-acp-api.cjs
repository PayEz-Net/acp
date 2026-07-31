/**
 * Prepare acp-api for bundling in the Electron installer.
 * Copies ./acp-api to a release directory, installs deps from package-lock,
 * builds it, prunes dev deps, and removes source files so only compiled
 * output + production node_modules ship.
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const source = path.resolve(__dirname, '../acp-api');
const dest = path.resolve(__dirname, '../acp-api-release');

function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const dstPath = path.join(dst, entry.name);
    // Skip VCS + Visual Studio cache + local node_modules/dist. .vs is removed
    // post-copy anyway, but a running VS holds a lock on .vs/**/*.vsidx that
    // makes copyFileSync throw (EPERM/EBUSY) — skip it at copy time.
    // node_modules and dist are recreated in the release dir so symlinks are
    // valid and the compiled output is fresh.
    if (
      entry.name === '.git' ||
      entry.name === '.vs' ||
      entry.name === 'node_modules' ||
      entry.name === 'dist' ||
      entry.name === 'release' ||
      entry.name === 'build' ||
      entry.name === 'data'
    ) continue;
    if (entry.isDirectory()) {
      copyDir(srcPath, dstPath);
    } else {
      fs.copyFileSync(srcPath, dstPath);
    }
  }
}

// Clean up old release
if (fs.existsSync(dest)) {
  console.log('[prepare-acp-api] Cleaning old release directory...');
  fs.rmSync(dest, { recursive: true, force: true });
}

// Copy acp-api source to release dir (no node_modules / dist)
console.log('[prepare-acp-api] Copying acp-api source to release directory...');
copyDir(source, dest);

// Install dependencies from the copied package-lock so bin wrappers/symlinks
// are valid in the release directory.
console.log('[prepare-acp-api] Installing acp-api dependencies...');
execSync('npm ci', { cwd: dest, stdio: 'inherit' });

// Build acp-api (ensure dist/ is fresh)
console.log('[prepare-acp-api] Building acp-api...');
execSync('npm run build', { cwd: dest, stdio: 'inherit' });

// Prune dev dependencies
console.log('[prepare-acp-api] Pruning dev dependencies...');
execSync('npm prune --production', { cwd: dest, stdio: 'inherit' });

// Remove source directories (only compiled dist/ should remain)
const sourceDirs = [
  'api', 'agents', 'autonomy', 'chat', 'collaboration', 'core',
  'kanban', 'docs', '__tests__', '.acp', '.acp-test', '.acp-test-collab',
  '.vs'
];
for (const dir of sourceDirs) {
  const p = path.join(dest, dir);
  if (fs.existsSync(p)) {
    fs.rmSync(p, { recursive: true, force: true });
    console.log(`[prepare-acp-api] Removed source dir: ${dir}`);
  }
}

// Remove source/config files
const sourceFiles = [
  'config.ts', 'tsconfig.json', 'jest.config.js', 'eslint.config.js',
  '.env', '.env.example', '.gitignore', 'CLAUDE.md', 'package-lock.json'
];
for (const file of sourceFiles) {
  const p = path.join(dest, file);
  if (fs.existsSync(p)) {
    fs.unlinkSync(p);
    console.log(`[prepare-acp-api] Removed source file: ${file}`);
  }
}

console.log('[prepare-acp-api] Done. Release ready at:', dest);
