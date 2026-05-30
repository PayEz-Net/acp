/**
 * Workspace Colonization — public contract (colonization spec v2 §3).
 *
 *   colonizeWorkspace(projectIdentity, opts?) ->
 *     { status: 'colonized'|'already-satisfied'|'rolled-back'|'skipped', root, items, notice? }
 *
 * Single-authority: the ONLY root source is `resolveWorkDir`, via the S3
 * seam (default = the real one, lazily required). Never resolves/composes
 * a path, no env-as-config tier, no fallback literal. Consent-first: no
 * recorded consent → no colonize (non-destructive). NEVER throws out of
 * this boundary (spec §3) — no raw ENOENT/Win32 to an IPC handler, never
 * a half-colonized folder.
 *
 * Invoked main-side at (a) first-authenticated-launch propagation,
 * (b) agent spawn (after resolveWorkDir, before pty.spawn), (c) project
 * switch (spec §5).
 */
import type {
  ColonizeOptions, ColonizeResult, ProjectIdentity, MaterializeCtx,
} from './types';
import { DEFAULT_REGISTRY } from './registry';
import { applyColonization } from './engine';

/** S3 default — the real single resolver, lazily required so importing this
 *  module (and its tests) does not pull electron/pty. */
function defaultResolveRoot(repoPath?: string | null): string | null {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { resolveWorkDir } = require('../pty');
  return resolveWorkDir(repoPath ?? undefined);
}

/** S5 default — the existing durable notice channel
 *  (<userData>/workdir-notices.log). No 2nd surfacing path (spec §3/§9).
 *  Best-effort, never throws. */
function defaultNoticeSink(notice: string): void {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const electron = require('electron');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs = require('fs'); const path = require('path');
    const sink = path.join(electron.app.getPath('userData'), 'workdir-notices.log');
    fs.appendFileSync(sink, `[${new Date().toISOString()}] [colonize] ${notice}\n`, 'utf8');
  } catch { /* best-effort; identical discipline to the workdir-skip notice */ }
}

export function colonizeWorkspace(
  identity: ProjectIdentity,
  opts: ColonizeOptions = {},
): ColonizeResult {
  const noticeSink = opts.noticeSink ?? defaultNoticeSink;
  const resolveRoot = opts.resolveRoot ?? defaultResolveRoot;
  const registry = opts.registry ?? DEFAULT_REGISTRY;
  const ctx: MaterializeCtx = { agents: opts.agents ?? [] };

  const skip = (notice: string): ColonizeResult => {
    noticeSink(notice);
    return { status: 'skipped', root: null, items: [], notice };
  };

  try {
    // Consent-first (spec §2.3/§8.7) — no consent → non-destructive no-op.
    if (!identity.colonizationConsented) {
      return skip('colonization not run: user consent not recorded (disclosure-first, spec §2.3/§8.7)');
    }

    // Single-authority root resolution (spec §4(1)). null → skip-notice.
    let root: string | null;
    try {
      root = resolveRoot(identity.repo_path);
    } catch (e) {
      return skip(`colonization skipped: workspace resolution error (${e instanceof Error ? e.message : String(e)})`);
    }
    if (!root) {
      return skip('colonization skipped: no resolvable workspace root; nothing created');
    }

    const r = applyColonization(root, registry, ctx, opts);
    const result: ColonizeResult = { status: r.status, root, items: r.items, notice: r.notice };
    if (r.notice && (r.status === 'rolled-back' || r.status === 'skipped')) noticeSink(r.notice);
    return result;
  } catch (err) {
    // Boundary guarantee: never throw out of colonizeWorkspace (spec §3).
    const notice = `colonization aborted defensively (${err instanceof Error ? err.message : String(err)}); folder not left half-colonized`;
    noticeSink(notice);
    return { status: 'rolled-back', root: null, items: [], notice };
  }
}

export type { ColonizeOptions, ColonizeResult, ProjectIdentity } from './types';
