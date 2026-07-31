#!/usr/bin/env node
/**
 * Manual workspace colonization (dev / recovery).
 *
 * Runs the production colonization engine directly without launching the full
 * Electron app. Useful for:
 *   - Initial seeding of a new Mac workspace
 *   - Re-colonizing after pulling new skill templates
 *   - Recovery when the installer handoff was missed/skipped
 *
 * Usage:
 *   node scripts/manual-colonize.cjs [workspace-root]
 *
 * Defaults to ~/Repos. Pass --dry-run to preview without writing.
 */

const fs = require('fs');
const path = require('path');
const Module = require('module');

const REPO_ROOT = path.resolve(__dirname, '..');
const DEFAULT_WORKSPACE = path.join(require('os').homedir(), 'Repos');

function usage() {
  console.log('Usage: node scripts/manual-colonize.cjs [workspace-root] [--dry-run]');
  console.log(`Default workspace: ${DEFAULT_WORKSPACE}`);
  process.exit(0);
}

const args = process.argv.slice(2);
if (args.includes('-h') || args.includes('--help')) usage();

const dryRun = args.includes('--dry-run');
const positional = args.filter((a) => !a.startsWith('-'));
const workspaceRoot = positional[0] ? path.resolve(positional[0]) : DEFAULT_WORKSPACE;

// Make the bundled colonize-templates discoverable from plain Node by
// presenting the same electron surface the engine uses in a packaged app.
process.resourcesPath = REPO_ROOT;
const mockElectron = {
  app: {
    isPackaged: true,
    getAppPath: () => REPO_ROOT,
  },
};
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'electron') return mockElectron;
  return originalLoad.apply(this, arguments);
};

// Ensure the main-process TypeScript is compiled. If dist is stale, surface it.
const colonizeModule = path.join(REPO_ROOT, 'dist', 'main', 'colonize', 'index.js');
if (!fs.existsSync(colonizeModule)) {
  console.error(`[manual-colonize] dist/main is missing. Run: npm run build:electron`);
  process.exit(1);
}

const { colonizeWorkspace } = require(colonizeModule);

const teamAgents = ['BAPert', 'Aurum', 'DotNetPert', 'QAPert', 'NextPert', 'InsightPert'];

if (dryRun) {
  console.log(`[dry-run] Would colonize: ${workspaceRoot}`);
  console.log(`[dry-run] Agents: ${teamAgents.join(', ')}`);
  process.exit(0);
}

console.log(`[manual-colonize] Colonizing ${workspaceRoot} ...`);

const result = colonizeWorkspace(
  { repo_path: workspaceRoot, colonizationConsented: true },
  {
    resolveRoot: () => workspaceRoot,
    agents: teamAgents,
    onFile: (action, name) => console.log(`  ${action}: ${name}`),
  },
);

console.log(`[manual-colonize] status: ${result.status}`);
if (result.root) console.log(`[manual-colonize] root: ${result.root}`);
if (result.notice) console.log(`[manual-colonize] notice: ${result.notice}`);

for (const item of result.items) {
  console.log(`  ${item.id}: ${item.outcome}${item.error ? ` (${item.error})` : ''}`);
}

if (result.status === 'rolled-back' || result.status === 'skipped') {
  process.exit(1);
}
