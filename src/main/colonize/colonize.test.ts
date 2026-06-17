/**
 * WO-COL-3 e2e matrix executed against the COL-5 S1–S5 seams
 * (colonization spec v2 §8 AC1–7 + cross-cutting). Spec §9: COL-5 is not
 * done until this is GREEN against real injectable seams. Pure node/fs +
 * os.tmpdir fixtures; S3 (resolveRoot) + S5 (noticeSink) overrides keep it
 * electron-free.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { colonizeWorkspace } from './index';
import type { ColonizationItem } from './types';

let root: string | null = null;
function mkRoot(): string { root = mkdtempSync(join(tmpdir(), 'colonize-')); return root; }
afterEach(() => { if (root) { rmSync(root, { recursive: true, force: true }); root = null; } });

function treeHash(dir: string): string {
  const h = createHash('sha256');
  const walk = (d: string, rel: string) => {
    for (const n of readdirSync(d).sort()) {
      if (n.startsWith('.acp-colonize')) continue; // stage dir + lockfile
      const abs = join(d, n); const r = rel ? `${rel}/${n}` : n;
      const st = statSync(abs);
      if (st.isDirectory()) walk(abs, r);
      else { h.update(r); h.update(readFileSync(abs)); }
    }
  };
  if (existsSync(dir)) walk(dir, '');
  return h.digest('hex');
}
const clean = (d: string) => !readdirSync(d).some((n) => n.startsWith('.acp-colonize'));
const consented = { repo_path: '/installer/decided', colonizationConsented: true };
const AGENTS = ['BAPert', 'QAPert'];

describe('colonizeWorkspace — WO-COL-3 matrix vs S1–S5 (spec v2 §8)', () => {
  it('AC1: fresh + consent → colonized, all registry items, no stage/lock left', () => {
    const r = mkRoot();
    const res = colonizeWorkspace(consented, { resolveRoot: () => r, noticeSink: () => {}, agents: AGENTS });
    expect(res.status).toBe('colonized');
    expect(res.root).toBe(r);
    for (const f of ['.claude/settings.json', '.claude/commands/report-bapert.md',
      '.claude/commands/report-qapert.md', '.kimi/kimi.json',
      '.inference-provider/config.json', '.acp/bootstrap.json']) {
      expect(statSync(join(r, f)).size, f).toBeGreaterThan(0);
    }
    expect(clean(r), 'no stage dir / lockfile remain').toBe(true);
  });

  it('AC2: re-run → already-satisfied, byte-identical, no dup; partial → self-heal', () => {
    const r = mkRoot();
    colonizeWorkspace(consented, { resolveRoot: () => r, noticeSink: () => {}, agents: AGENTS });
    const h0 = treeHash(r);
    const re = colonizeWorkspace(consented, { resolveRoot: () => r, noticeSink: () => {}, agents: AGENTS });
    expect(re.status).toBe('already-satisfied');
    expect(treeHash(r)).toBe(h0);
    expect(clean(r)).toBe(true);
    rmSync(join(r, '.kimi'), { recursive: true, force: true });
    const heal = colonizeWorkspace(consented, { resolveRoot: () => r, noticeSink: () => {}, agents: AGENTS });
    expect(heal.status).toBe('colonized');
    expect(existsSync(join(r, '.kimi/kimi.json'))).toBe(true);
    expect(treeHash(r)).toBe(h0);
  });

  it.each(['stage', 'validate', 'post-first-commit'] as const)(
    'AC3 (S2 %s fault): rolled-back, folder byte-identical, notice surfaced (atomic)',
    (phase) => {
      const r = mkRoot();
      const pre = treeHash(r);
      const notices: string[] = [];
      const res = colonizeWorkspace(consented, {
        resolveRoot: () => r, noticeSink: (n) => notices.push(n), agents: AGENTS,
        faultInject: { phase },
      });
      expect(res.status).toBe('rolled-back');
      expect(treeHash(r), 'folder byte-identical to pre-run').toBe(pre);
      expect(clean(r), 'stage/lock cleaned').toBe(true);
      expect(notices.join(' ')).toMatch(/rolled back/i);
    });

  it('AC4 (S3 → null): skipped, no crash, no partial, notice via the sink', () => {
    const r = mkRoot();
    const notices: string[] = [];
    const res = colonizeWorkspace(consented, { resolveRoot: () => null, noticeSink: (n) => notices.push(n), agents: AGENTS });
    expect(res.status).toBe('skipped');
    expect(res.root).toBeNull();
    expect(readdirSync(r).length, 'nothing written').toBe(0);
    expect(notices.length).toBeGreaterThan(0);
  });

  it('REGRESSION (merge): re-materializing an owned top-level PRESERVES sibling files the item does not own', () => {
    const r = mkRoot();
    // first colonize establishes .claude (settings + report-bapert.md)
    colonizeWorkspace(consented, { resolveRoot: () => r, noticeSink: () => {}, agents: ['BAPert'] });
    // user/installer drops skills UNDER .claude that the claude item never owns
    mkdirSync(join(r, '.claude', 'skills', 'custom'), { recursive: true });
    writeFileSync(join(r, '.claude', 'skills', 'custom', 'SKILL.md'), 'CUSTOM-DO-NOT-LOSE');
    // a NEW agent → claude.check fails (missing report-qapert.md) → the whole
    // .claude top-level is re-materialized + swapped. Pre-fix this DELETED the
    // sibling skills tree (and the only backup with it).
    const res = colonizeWorkspace(consented, { resolveRoot: () => r, noticeSink: () => {}, agents: ['BAPert', 'QAPert'] });
    expect(res.status).toBe('colonized');
    expect(existsSync(join(r, '.claude', 'commands', 'report-qapert.md')), 'new report command landed').toBe(true);
    expect(existsSync(join(r, '.claude', 'skills', 'custom', 'SKILL.md')), 'sibling skill survives re-materialize').toBe(true);
    expect(readFileSync(join(r, '.claude', 'skills', 'custom', 'SKILL.md'), 'utf8')).toBe('CUSTOM-DO-NOT-LOSE');
  });

  it('AC5 (S1 registry injection): new item materializes, nothing else touched', () => {
    const r = mkRoot();
    const testItem: ColonizationItem = {
      id: 'test-only', critical: false,
      check: (rt) => existsSync(join(rt, '.test-only', 'm.txt')),
      materialize: (stage) => { mkdirSync(join(stage, '.test-only'), { recursive: true }); writeFileSync(join(stage, '.test-only', 'm.txt'), 'x'); },
    };
    const res = colonizeWorkspace(consented, { resolveRoot: () => r, noticeSink: () => {}, agents: AGENTS, registry: [testItem] });
    expect(res.status).toBe('colonized');
    expect(existsSync(join(r, '.test-only/m.txt'))).toBe(true);
    expect(existsSync(join(r, '.claude')), 'production items NOT run (registry is sole source)').toBe(false);
  });

  it('AC7 (consent gate): no consent → skipped, folder untouched, advisory notice', () => {
    const r = mkRoot();
    const notices: string[] = [];
    const res = colonizeWorkspace({ repo_path: '/x', colonizationConsented: false },
      { resolveRoot: () => r, noticeSink: (n) => notices.push(n), agents: AGENTS });
    expect(res.status).toBe('skipped');
    expect(readdirSync(r).length).toBe(0);
    expect(notices.join(' ')).toMatch(/consent/i);
  });

  it('cross-cutting: per-root lockfile — live lock → skipped (non-destructive); stale → stolen', () => {
    const r = mkRoot();
    writeFileSync(join(r, '.acp-colonize.lock'), JSON.stringify({ pid: 999999, ts: Date.now() }));
    const held = colonizeWorkspace(consented, { resolveRoot: () => r, noticeSink: () => {}, agents: AGENTS, lockWaitMs: 40 });
    expect(held.status).toBe('skipped');
    expect(existsSync(join(r, '.claude')), 'no partial while lock held').toBe(false);
    writeFileSync(join(r, '.acp-colonize.lock'), JSON.stringify({ pid: 999999, ts: Date.now() - 120_000 }));
    const stolen = colonizeWorkspace(consented, { resolveRoot: () => r, noticeSink: () => {}, agents: AGENTS, lockWaitMs: 40 });
    expect(stolen.status).toBe('colonized');
    expect(clean(r)).toBe(true);
  });

  it('boundary: colonizeWorkspace NEVER throws (spec §3) even if resolveRoot throws', () => {
    const r = mkRoot();
    const notices: string[] = [];
    let res: any;
    expect(() => {
      res = colonizeWorkspace(consented, { resolveRoot: () => { throw new Error('boom'); }, noticeSink: (n) => notices.push(n), agents: AGENTS });
    }).not.toThrow();
    expect(res.status).toBe('skipped');
    expect(readdirSync(r).length).toBe(0);
  });
});
