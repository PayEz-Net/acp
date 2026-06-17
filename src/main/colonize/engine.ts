/**
 * Atomic apply engine (colonization spec §4). Invoked by index.ts AFTER
 * root resolution + consent. Guarantees: idempotent (per-item content-aware
 * check), atomic (all-or-nothing — stage → validate → per-item atomic swap
 * → this-run rollback on any failure, commit nothing on failure), and
 * concurrency-safe (per-root lockfile for the multi-agent spawn race).
 * Never throws out of `applyColonization` — failures become 'rolled-back'.
 * S2 (phase fault) + S4 (rundid / lockWaitMs) seams honored here.
 */
import * as fs from 'fs';
import * as path from 'path';
import type { ColonizationItem, ColonizeOptions, ItemResult, MaterializeCtx } from './types';

export interface EngineResult {
  status: 'colonized' | 'already-satisfied' | 'rolled-back' | 'skipped';
  items: ItemResult[];
  notice?: string;
}

const LOCK_NAME = '.acp-colonize.lock';
const LOCK_STALE_MS = 60_000;
const LOCK_WAIT_MS = 10_000;
const LOCK_POLL_MS = 100;

function rm(p: string): void {
  try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* best-effort */ }
}
function topLevelEntries(dir: string): string[] {
  try { return fs.readdirSync(dir); } catch { return []; }
}
/**
 * Back-fill `stageDir` with every file under `existingDir` that the staged tree
 * does NOT already provide, recursing into shared subdirs. Makes the atomic
 * top-level dir-swap a MERGE, not a REPLACE: sibling content an item doesn't
 * itself materialize (e.g. user/installed `.claude/skills` the claude item
 * doesn't own) is carried into the new dir instead of being clobbered when a
 * forced re-materialize (item.check failed) swaps the whole top-level — after
 * which the success-path stage rm would delete the only backup (the data-loss
 * bug). Staged files always win (gaps only). Best-effort; never aborts commit.
 */
function mergeMissingInto(existingDir: string, stageDir: string): void {
  let entries: string[];
  try { entries = fs.readdirSync(existingDir); } catch { return; }
  for (const name of entries) {
    const ex = path.join(existingDir, name);
    const st = path.join(stageDir, name);
    let isDir = false;
    try { isDir = fs.statSync(ex).isDirectory(); } catch { continue; }
    if (isDir) {
      try { fs.mkdirSync(st, { recursive: true }); } catch { /* best-effort */ }
      mergeMissingInto(ex, st);
    } else if (!fs.existsSync(st)) {
      try { fs.mkdirSync(path.dirname(st), { recursive: true }); fs.copyFileSync(ex, st); }
      catch { /* best-effort preserve */ }
    }
  }
}
function fault(opts: ColonizeOptions, phase: 'stage' | 'validate' | 'post-first-commit', itemId?: string): void {
  const fi = opts.faultInject;
  if (fi && fi.phase === phase && (!fi.itemId || fi.itemId === itemId)) {
    throw new Error(`[colonize:S2] injected fault at ${phase}${itemId ? ` (${itemId})` : ''}`);
  }
}

/** Acquire the per-root lock. Returns a release fn, or null if a live run
 *  already owns it (caller → non-destructive 'skipped'). */
function acquireLock(root: string, waitMs: number): (() => void) | null {
  const lock = path.join(root, LOCK_NAME);
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      const fd = fs.openSync(lock, 'wx'); // atomic create-exclusive
      fs.writeSync(fd, JSON.stringify({ pid: process.pid, ts: Date.now() }));
      fs.closeSync(fd);
      return () => { try { fs.unlinkSync(lock); } catch { /* already gone */ } };
    } catch (e) {
      if ((e as NodeJS.ErrnoException)?.code !== 'EEXIST') throw e;
      let stale = false;
      try {
        const meta = JSON.parse(fs.readFileSync(lock, 'utf8'));
        stale = !meta?.ts || (Date.now() - meta.ts) > LOCK_STALE_MS;
      } catch { stale = true; } // unreadable/garbage lock → treat stale
      if (stale) { try { fs.unlinkSync(lock); } catch { /* race */ } continue; }
      if (Date.now() >= deadline) return null; // live run owns it
      const until = Date.now() + LOCK_POLL_MS;
      while (Date.now() < until) { /* brief spin; deterministic w/ S4 in tests */ }
    }
  }
}

export function applyColonization(
  root: string,
  registry: ColonizationItem[],
  ctx: MaterializeCtx,
  opts: ColonizeOptions,
): EngineResult {
  const release = acquireLock(root, opts.lockWaitMs ?? LOCK_WAIT_MS);
  if (!release) {
    return { status: 'skipped', items: [], notice: `colonization already in progress for ${root}` };
  }

  const rundid = opts.rundid ?? `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const stageRoot = path.join(root, `.acp-colonize-${rundid}`);
  const backupRoot = path.join(stageRoot, '.rollback');
  // committed this run, in order: { id, entries:[{name, hadBackup}] }
  const committed: Array<{ id: string; entries: Array<{ name: string; hadBackup: boolean }> }> = [];

  try {
    // (2) idempotent per-item check
    const items: ItemResult[] = [];
    const todo: ColonizationItem[] = [];
    for (const it of registry) {
      if (it.check(root, ctx)) items.push({ id: it.id, outcome: 'already-satisfied' });
      else todo.push(it);
    }
    if (todo.length === 0) { release(); return { status: 'already-satisfied', items }; }

    // (3) stage: materialize each unsatisfied item under <stage>/<id>/
    fs.mkdirSync(stageRoot, { recursive: true });
    for (const it of todo) {
      fault(opts, 'stage', it.id);
      const itemStage = path.join(stageRoot, it.id);
      fs.mkdirSync(itemStage, { recursive: true });
      it.materialize(itemStage, ctx);
    }

    // (4) validate the FULL staged set (item.check must pass against its
    //     own staged tree as if it were root). Any (or any critical) fail → roll back.
    for (const it of todo) {
      fault(opts, 'validate', it.id);
      const ok = it.check(path.join(stageRoot, it.id), ctx);
      if (!ok) {
        rm(stageRoot);
        return {
          status: 'rolled-back',
          items: [...items, ...todo.map((t) => ({ id: t.id, outcome: 'rolled-back' as const }))],
          notice: `colonization rolled back: item '${it.id}' failed validation (critical=${it.critical}); folder unchanged`,
        };
      }
    }

    // (5) commit: per item, atomic-swap each owned top-level entry into root,
    //     backing up any existing entry for this-run rollback.
    fs.mkdirSync(backupRoot, { recursive: true });
    for (let i = 0; i < todo.length; i++) {
      const it = todo[i];
      const itemStage = path.join(stageRoot, it.id);
      const entries = topLevelEntries(itemStage);
      // Install-time readout (spec §observability): emit each staged file as
      // insert/overwrite BEFORE the swap (pre-swap existence = truthful). No
      // deletes, no semantic change; a throw here must never break colonize.
      if (opts.onFile) {
        try {
          const walk = (d: string, rel: string): void => {
            for (const e of fs.readdirSync(d)) {
              const abs = path.join(d, e);
              const r = rel ? `${rel}/${e}` : e;
              if (fs.statSync(abs).isDirectory()) walk(abs, r);
              else opts.onFile!(fs.existsSync(path.join(root, r)) ? 'overwrite' : 'insert', r);
            }
          };
          walk(itemStage, '');
        } catch { /* readout is best-effort only */ }
      }
      const placed: Array<{ name: string; hadBackup: boolean }> = [];
      for (const name of entries) {
        const target = path.join(root, name);
        const staged = path.join(itemStage, name);
        // Preserve siblings: if this owned top-level already exists as a dir,
        // fill the staged copy with any files the item did NOT materialize so
        // the swap below MERGES rather than REPLACES. (Fixes the destructive
        // re-materialize that wiped .claude/skills.) Staged files always win.
        try {
          if (fs.existsSync(target) && fs.statSync(target).isDirectory() && fs.statSync(staged).isDirectory()) {
            mergeMissingInto(target, staged);
          }
        } catch { /* best-effort preserve; the swap still proceeds */ }
        const itemBackup = path.join(backupRoot, it.id);
        let hadBackup = false;
        if (fs.existsSync(target)) {
          fs.mkdirSync(itemBackup, { recursive: true });
          fs.renameSync(target, path.join(itemBackup, name));
          hadBackup = true;
        }
        fs.renameSync(staged, target);
        placed.push({ name, hadBackup });
      }
      committed.push({ id: it.id, entries: placed });
      items.push({ id: it.id, outcome: 'materialized' });
      if (i === 0) fault(opts, 'post-first-commit', it.id); // S2: fail AFTER 1st commit
    }

    rm(stageRoot); // success: drop stage + backups
    release();
    return { status: 'colonized', items };
  } catch (err) {
    // Roll back this-run commits in reverse, restore backups, commit nothing.
    for (const c of committed.reverse()) {
      for (const e of c.entries) {
        const target = path.join(root, e.name);
        rm(target);
        if (e.hadBackup) {
          try { fs.renameSync(path.join(backupRoot, c.id, e.name), target); } catch { /* best-effort */ }
        }
      }
    }
    rm(stageRoot);
    release();
    const msg = err instanceof Error ? err.message : String(err);
    return {
      status: 'rolled-back',
      items: registry.map((r) => ({ id: r.id, outcome: 'rolled-back' as const })),
      notice: `colonization rolled back (${msg}); folder restored, nothing committed`,
    };
  }
}
