#!/usr/bin/env node
/**
 * publish-github-release — publish the ACP installer to a public GitHub Release
 * with the DURABLE two-asset convention. Run AFTER `npm run dist` (prod build).
 *
 * Why this script exists (the anti-pattern it kills):
 *   electron-builder NSIS names the installer with the version baked in
 *   ("ACP Setup <ver>.exe"), and GitHub sanitizes that to "ACP.Setup.<ver>.exe".
 *   A version-in-filename asset means winget/scoop/curl one-liners and the
 *   `releases/latest/download/<name>` URL break on EVERY new version. So every
 *   release MUST also publish a version-LESS, platform-tagged alias with the
 *   SAME bytes, giving one stable forever-URL:
 *       https://github.com/PayEz-Net/acp/releases/latest/download/ACP-Setup-win-x64.exe
 *
 * Two assets, every release:
 *   1) ACP.Setup.<ver>.exe        — versioned; the npm wrapper resolves THIS by
 *                                    package version. (electron-builder name;
 *                                    GitHub turns spaces -> dots on upload.)
 *   2) ACP-Setup-win-x64.exe      — version-less alias; same bytes; stable URL.
 *
 * SAFETY: refuses anything but a clean prod installer. A `_93`-suffixed (dev93)
 * build must never be published, and the alias must carry prod bytes.
 *
 * Usage:  node scripts/publish-github-release.cjs [--release-dir release]
 *         (gh CLI must be authed against an account with push to PayEz-Net/acp)
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO = 'PayEz-Net/acp';
const ALIAS = 'ACP-Setup-win-x64.exe'; // version-less, platform-tagged
const ROOT = path.join(__dirname, '..');

function fail(msg) {
  console.error(`[publish-release] FATAL: ${msg}`);
  process.exit(1);
}

// Quote an arg for the shell when it contains whitespace/quotes. Required
// because we run with shell:true (so gh resolves on Windows/Git Bash), and
// Node does NOT auto-quote array args under shell:true — an unquoted
// "ACP v1.0.1" title would split and gh would read "v1.0.1" as an asset path.
function q(a) {
  const s = String(a);
  return /[\s"']/.test(s) ? `"${s.replace(/(["\\$`])/g, '\\$1')}"` : s;
}
function sh(cmd, args, opts = {}) {
  const r = spawnSync(`${cmd} ${args.map(q).join(' ')}`, { stdio: 'inherit', shell: true, ...opts });
  return r.status === null ? 1 : r.status;
}
function shCapture(cmd, args) {
  const r = spawnSync(`${cmd} ${args.map(q).join(' ')}`, { shell: true, encoding: 'utf8' });
  return { status: r.status === null ? 1 : r.status, out: (r.stdout || '').trim() };
}

// --- args ---
const dirArg = process.argv.indexOf('--release-dir');
const releaseDir = path.resolve(ROOT, dirArg !== -1 ? process.argv[dirArg + 1] : 'release');

// --- version (single source of truth: acp-desktop/package.json) ---
const version = require(path.join(ROOT, 'package.json')).version;
if (!version) fail('could not read version from package.json');
const tag = `v${version}`;

// --- locate the built prod installer; refuse dev93 ---
const versionedName = `ACP Setup ${version}.exe`; // electron-builder prod name (spaces)
const versionedPath = path.join(releaseDir, versionedName);
const dev93Path = path.join(releaseDir, `ACP Setup ${version}_93.exe`);
if (fs.existsSync(dev93Path) && !fs.existsSync(versionedPath)) {
  fail(`found a _93 (dev93) installer but no prod installer in ${releaseDir}. Refusing to publish a dev93 build. Run \`npm run dist\` (prod) first.`);
}
if (!fs.existsSync(versionedPath)) {
  fail(`prod installer not found: ${versionedPath}\n  Run \`npm run dist\` (prod build) before publishing.`);
}

// --- make the version-less alias (same bytes) ---
const aliasPath = path.join(releaseDir, ALIAS);
fs.copyFileSync(versionedPath, aliasPath);
const bytes = fs.statSync(aliasPath).size;
console.log(`[publish-release] ${tag}: versioned='${versionedName}' (${bytes} bytes) -> alias='${ALIAS}'`);

// --- ensure the release exists (create from CHANGELOG [version] if absent) ---
const exists = shCapture('gh', ['release', 'view', tag, '-R', REPO, '--json', 'tagName']).status === 0;
if (!exists) {
  const notesPath = extractChangelogNotes(version);
  console.log(`[publish-release] creating release ${tag}`);
  const args = ['release', 'create', tag, '-R', REPO, '--target', 'main', '--title', `ACP v${version}`];
  if (notesPath) args.push('--notes-file', notesPath);
  else args.push('--generate-notes');
  if (sh('gh', args) !== 0) fail(`gh release create ${tag} failed`);
} else {
  console.log(`[publish-release] release ${tag} already exists — uploading assets`);
}

// --- upload BOTH assets (clobber so re-runs are idempotent) ---
if (sh('gh', ['release', 'upload', tag, '-R', REPO, '--clobber', versionedPath, aliasPath]) !== 0) {
  fail('gh release upload failed');
}

const latestUrl = `https://github.com/${REPO}/releases/latest/download/${ALIAS}`;
console.log(`\n[publish-release] DONE. Both assets uploaded to ${tag}.`);
console.log(`[publish-release] Stable latest URL (wire-verify this 200s): ${latestUrl}`);

/** Extract the `## [version]` section of CHANGELOG.md into a temp notes file; null if absent. */
function extractChangelogNotes(ver) {
  const clPath = path.join(ROOT, 'CHANGELOG.md');
  if (!fs.existsSync(clPath)) return null;
  const lines = fs.readFileSync(clPath, 'utf8').split(/\r?\n/);
  const start = lines.findIndex((l) => l.match(new RegExp(`^##\\s*\\[${ver.replace(/\./g, '\\.')}\\]`)));
  if (start === -1) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^##\s*\[/.test(lines[i])) { end = i; break; }
  }
  // body = lines after the heading, trimmed of trailing '---' separators/blank lines
  const body = lines.slice(start + 1, end).join('\n').replace(/\n*-{3,}\s*$/,'').trim();
  const out = path.join(releaseDir, `${tag}-notes.generated.md`);
  fs.writeFileSync(out, body + '\n');
  return out;
}
