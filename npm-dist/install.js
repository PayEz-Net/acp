#!/usr/bin/env node
/**
 * Postinstall — fetches the platform-appropriate ACP installer from the
 * GitHub Release matching this package's version and saves it locally so
 * `bin/acp-desktop.js` can spawn it on user invocation.
 *
 * Topology (locked 2026-05-20):
 *   - source code on GitHub (Aurum owns the actual URL; resolved from
 *     this package.json's `repository.url`)
 *   - installable on npm (this thin wrapper; ~kilobytes tarball)
 *   - binaries on GitHub Releases (downloaded here on `npm install`)
 *
 * Why postinstall download instead of bundling installer.exe in the tarball:
 *   - installer is ~85MB, would push npm tarballs past CDN-friendly sizes
 *   - bundling means every `npm update` re-downloads the full installer
 *     even when only the wrapper changed
 *   - cross-platform support cleanly: download mac/linux on those OSes
 *     instead of shipping all in one fat tarball
 *
 * Soft-fail behavior: this script MUST NOT cause `npm install` to fail
 * even when the download cannot complete (network, no release yet,
 * proxy block, etc.). On failure, log a clear manual-install URL and
 * exit 0. The user gets a tarball without installer.exe and a clear
 * error if they run `acp-desktop` — no silent breakage.
 */

const fs = require('fs');
const https = require('https');
const path = require('path');

const pkg = require('./package.json');
const VERSION = pkg.version;

/**
 * Parse a GitHub owner/repo pair out of the package.json `repository` field.
 * Supports both shorthand strings and object form, with or without `.git`
 * suffix, with or without `git+` prefix.
 */
function parseGitHubOwnerRepo(repository) {
  if (!repository) return null;
  const urlStr = typeof repository === 'string' ? repository : repository.url;
  if (!urlStr) return null;
  const match = urlStr.match(/github\.com[/:]([^/]+)\/([^/.]+?)(?:\.git)?(?:[/?#]|$)/);
  if (!match) return null;
  return { owner: match[1], repo: match[2] };
}

function platformAssetName(version) {
  // electron-builder NSIS produces `<productName> Setup <version>.exe`
  // (`productName: "ACP"`), i.e. `ACP Setup <version>.exe` — WITH spaces.
  // BUT GitHub Releases sanitizes asset filenames on upload: spaces become
  // dots. The hosted asset is therefore `ACP.Setup.<version>.exe`, and the
  // download URL MUST request that dotted name — requesting the spaced name
  // (`ACP%20Setup%20...`) 404s. Verified on the wire 2026-06-16:
  // spaced -> 404, dotted -> 200. Keep the builder name as the source of
  // truth and apply GitHub's space->dot rule explicitly.
  if (process.platform === 'win32') return `ACP Setup ${version}.exe`.replace(/ /g, '.');
  // Cross-platform support is future work; v0.1 is Windows-only per
  // npm-dist/package.json `os: ["win32"]`. macOS/Linux assets would
  // resolve here when those targets are added.
  return null;
}

function targetPath() {
  // bin/acp-desktop.js spawns `path.join(__dirname, '..', 'installer.exe')`,
  // so the download target is the wrapper root regardless of platform.
  return path.join(__dirname, 'installer.exe');
}

function softFail(reason, manualUrl) {
  console.error(`[acp-desktop install] could not auto-download installer: ${reason}`);
  if (manualUrl) {
    console.error(`  manual install: download ${manualUrl}`);
    console.error(`  then save as: ${targetPath()}`);
  }
  console.error(`  the npm package is otherwise installed; run \`acp-desktop\` after manual install completes.`);
  process.exit(0); // never break npm install
}

const gh = parseGitHubOwnerRepo(pkg.repository);
if (!gh) {
  softFail(
    "could not parse a github.com URL from package.json repository field",
    null,
  );
}

const assetName = platformAssetName(VERSION);
if (!assetName) {
  softFail(
    `platform ${process.platform} is not supported by this wrapper`,
    null,
  );
}

const ASSET_URL =
  `https://github.com/${gh.owner}/${gh.repo}` +
  `/releases/download/v${VERSION}/${encodeURIComponent(assetName)}`;
const TARGET = targetPath();

function download(downloadUrl, dest, redirectsLeft = 5) {
  return new Promise((resolve, reject) => {
    if (redirectsLeft <= 0) {
      reject(new Error('too many redirects'));
      return;
    }
    const req = https.get(downloadUrl, (res) => {
      // GitHub asset URLs 302 to the CDN host
      if (res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 307) {
        const next = res.headers.location;
        if (!next) {
          reject(new Error(`HTTP ${res.statusCode} with no Location header`));
          return;
        }
        res.resume();
        resolve(download(next, dest, redirectsLeft - 1));
        return;
      }
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode} from ${downloadUrl}`));
        return;
      }
      const file = fs.createWriteStream(dest);
      res.pipe(file);
      file.on('finish', () => file.close(() => resolve()));
      file.on('error', (err) => {
        try { fs.unlinkSync(dest); } catch { /* ignore */ }
        reject(err);
      });
    });
    req.on('error', reject);
    req.setTimeout(60000, () => req.destroy(new Error('timeout after 60s')));
  });
}

console.log(`[acp-desktop install] downloading ${ASSET_URL}`);
console.log(`[acp-desktop install] target ${TARGET}`);

download(ASSET_URL, TARGET).then(
  () => {
    console.log(`[acp-desktop install] installer ready. run \`acp-desktop\` to launch.`);
  },
  (err) => {
    softFail(err.message || String(err), ASSET_URL);
  },
);
