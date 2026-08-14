/**
 * Single userData root (kanban 184949).
 *
 * THE TRAP. This app has two candidate userData roots on one box:
 *   %APPDATA%\ACP                            (packaged: electron-builder productName)
 *   %APPDATA%\agent-collaboration-platform   (dev: package.json "name")
 * Both get populated because both kinds of process run on a dev box, and both
 * carry a plausible-looking auth.json. Only artifact archaeology (which root
 * holds the live agent-output-spill queue) told you which one the running
 * process actually used — and a diagnosis against the wrong root is
 * confidently wrong, not obviously wrong. QAPert measured it; this module is
 * the fix.
 *
 * THE FIX. ONE root, named after the shipped productName ("ACP"):
 *  1. userData is pinned to <appData>/ACP in dev AND packaged runs, so the
 *     root no longer depends on how the process was launched.
 *  2. If the legacy dev-named root exists, its state is MOVED into the ACP
 *     root (the legacy root is the live one on a dev box — it wins conflicts
 *     when its file is newer), then the legacy root is removed so it can
 *     never masquerade as live again.
 *  3. Everything is logged: after this, which root is live is a printed fact
 *     (see also mainLog, 185035), not a guess.
 *
 * SAFETY.
 *  - Moves are within the same parent dir (same volume) → rename is atomic.
 *  - A file present in BOTH roots is only displaced when the legacy copy is
 *    strictly newer; equal/older legacy copies are discarded with the root.
 *  - Never throws: a failed migration degrades to "app keeps its default
 *    root" — the pre-fix behavior — rather than crashing boot. The failure is
 *    logged either way.
 *  - Must run BEFORE anything reads app.getPath('userData') and before
 *    app.requestSingleInstanceLock() (the lock file lives under userData).
 *    index.ts calls ensureSingleUserDataRoot(app) at module scope for this
 *    reason; app.setPath('userData') is only valid pre-ready.
 */
import * as fs from 'fs';
import * as path from 'path';

/** Minimal slice of Electron's App this module needs — mockable in tests. */
export interface AppLike {
  getPath(name: 'appData' | 'userData'): string;
  setPath(name: 'userData', p: string): void;
}

export interface UserDataRootResult {
  /** The one canonical root the app is now pinned to. */
  desiredRoot: string;
  /** The legacy dev-named root that was migrated away from (if it existed). */
  legacyRoot: string;
  /** Whether userData was repointed (false when already at desiredRoot). */
  repointed: boolean;
  /** Relative paths moved legacy -> desired (newer-wins on conflict). */
  moved: string[];
  /** Relative paths NOT moved because the desired copy was same-age or newer. */
  keptExisting: string[];
  /** Whether the legacy root was removed (false when it never existed). */
  removedLegacyRoot: boolean;
  /** Boot-log lines; index.ts re-emits these once mainLog is teeing. */
  lines: string[];
}

const DEFAULT_PRODUCT_NAME = 'ACP';
const DEFAULT_LEGACY_NAME = 'agent-collaboration-platform';

/** Pure path math, exported for tests. */
export function resolveRoots(
  appDataDir: string,
  productName = DEFAULT_PRODUCT_NAME,
  legacyName = DEFAULT_LEGACY_NAME,
): { desiredRoot: string; legacyRoot: string } {
  return {
    desiredRoot: path.join(appDataDir, productName),
    legacyRoot: path.join(appDataDir, legacyName),
  };
}

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function mtimeMs(p: string): number {
  try {
    return fs.statSync(p).mtimeMs;
  } catch {
    return 0;
  }
}

/** Move src -> dst, overwriting dst. rename first (atomic, same volume); fall back to copy+unlink. */
function moveFile(src: string, dst: string): void {
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  try {
    // Windows rename will not overwrite an existing file — remove it first.
    fs.rmSync(dst, { force: true });
    fs.renameSync(src, dst);
  } catch {
    fs.copyFileSync(src, dst);
    fs.unlinkSync(src);
  }
}

/**
 * Merge the legacy root into the desired root (legacy-newer-wins per file),
 * then remove the legacy root. No-op when the legacy root does not exist.
 * Exported for tests; operates purely on paths.
 */
export function migrateLegacyRoot(
  appDataDir: string,
  productName = DEFAULT_PRODUCT_NAME,
  legacyName = DEFAULT_LEGACY_NAME,
): Pick<UserDataRootResult, 'moved' | 'keptExisting' | 'removedLegacyRoot'> {
  const { desiredRoot, legacyRoot } = resolveRoots(appDataDir, productName, legacyName);
  const moved: string[] = [];
  const keptExisting: string[] = [];

  if (!isDir(legacyRoot)) {
    return { moved, keptExisting, removedLegacyRoot: false };
  }

  if (!isDir(desiredRoot)) {
    // Whole-root rename: every byte lands in one atomic step.
    fs.renameSync(legacyRoot, desiredRoot);
    for (const rel of walkFiles(desiredRoot)) moved.push(rel);
    return { moved, keptExisting, removedLegacyRoot: true };
  }

  // Both roots populated (the dev-box reality QAPert measured). Per file:
  // move when desired lacks it or the legacy copy is strictly newer.
  for (const rel of walkFiles(legacyRoot)) {
    const src = path.join(legacyRoot, rel);
    const dst = path.join(desiredRoot, rel);
    const dstExists = fs.existsSync(dst);
    if (!dstExists || mtimeMs(src) > mtimeMs(dst)) {
      moveFile(src, dst);
      moved.push(rel);
    } else {
      keptExisting.push(rel);
    }
  }
  // What remains in legacy is only files whose newer twin is now in desired,
  // plus the emptied directory skeleton. Remove it so the stale root can
  // never be mistaken for the live one again.
  fs.rmSync(legacyRoot, { recursive: true, force: true });
  return { moved, keptExisting, removedLegacyRoot: true };
}

function walkFiles(root: string, prefix = ''): string[] {
  const out: string[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const rel = prefix ? path.join(prefix, e.name) : e.name;
    const full = path.join(root, e.name);
    if (e.isDirectory()) out.push(...walkFiles(full, rel));
    else out.push(rel);
  }
  return out;
}

/**
 * Pin userData to the single canonical root and migrate legacy state into it.
 * Call at module scope in the main process, BEFORE the single-instance lock
 * and before any getPath('userData') read. NEVER throws.
 */
export function ensureSingleUserDataRoot(
  app: AppLike,
  productName = DEFAULT_PRODUCT_NAME,
  legacyName = DEFAULT_LEGACY_NAME,
): UserDataRootResult {
  const appData = app.getPath('appData');
  const { desiredRoot, legacyRoot } = resolveRoots(appData, productName, legacyName);
  const lines: string[] = [];
  let moved: string[] = [];
  let keptExisting: string[] = [];
  let removedLegacyRoot = false;
  let repointed = false;

  try {
    const migration = migrateLegacyRoot(appData, productName, legacyName);
    moved = migration.moved;
    keptExisting = migration.keptExisting;
    removedLegacyRoot = migration.removedLegacyRoot;
    if (removedLegacyRoot) {
      lines.push(
        `[184949] migrated legacy userData root '${legacyName}' -> '${productName}': ` +
          `${moved.length} moved, ${keptExisting.length} already-current; stale root removed.`,
      );
      if (keptExisting.length > 0) {
        lines.push(`[184949] kept existing (same-age or newer): ${keptExisting.join(', ')}`);
      }
    }
  } catch (e) {
    // Degrade to pre-fix behavior; the log line is the tripwire.
    lines.push(`[184949] legacy userData migration FAILED (keeping default root): ${String(e)}`);
  }

  try {
    if (path.resolve(app.getPath('userData')) !== path.resolve(desiredRoot)) {
      app.setPath('userData', desiredRoot);
      repointed = true;
    }
  } catch (e) {
    lines.push(`[184949] setPath('userData') FAILED (keeping default root): ${String(e)}`);
  }

  lines.unshift(`[184949] userData root resolved: ${desiredRoot}${repointed ? ' (repointed)' : ''}`);
  return { desiredRoot, legacyRoot, repointed, moved, keptExisting, removedLegacyRoot, lines };
}
