/**
 * Regression test for the workspace-debt guard — the guard is the
 * workstream-3 ratchet, so it must itself be regression-protected (a
 * broken clause = debt regrows undetected). Self-contained: spawns the
 * guard against os.tmpdir fixtures via --scan-dir (does NOT scan the
 * repo HEAD except the one explicit "HEAD scan" case).
 *
 * NOTE (acp-desktop): not yet wired into `npm test` (no scripts glob /
 * no pretest) until the COL port cleans acp-desktop's own diverged debt;
 * wiring before that = self-inflicted red build. These tests are correct
 * and runnable in isolation now; activation is the final port milestone.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const GUARD = fileURLToPath(new URL('./guard-workspace-debt.mjs', import.meta.url));
function runGuard(args: string[] = []) {
  const r = spawnSync(process.execPath, [GUARD, ...args], { encoding: 'utf8' });
  return { code: r.status, out: `${r.stdout}\n${r.stderr}` };
}
let fixtureRoot: string | null = null;
function fixture(files: Record<string, string>): string {
  fixtureRoot = mkdtempSync(join(tmpdir(), 'wsguard-'));
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(fixtureRoot, rel);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, content, 'utf8');
  }
  return fixtureRoot;
}
afterEach(() => { if (fixtureRoot) { rmSync(fixtureRoot, { recursive: true, force: true }); fixtureRoot = null; } });

describe('workspace-debt guard (ratchet)', () => {
  it('clause A — drive-letter literal fails', () => {
    const dir = fixture({ 'src/main/a.ts': `export const x = 'C:\\\\Repos\\\\bad';\n` });
    const { code, out } = runGuard(['--scan-dir', dir]);
    expect(code, out).toBe(1);
    expect(out).toMatch(/A:drive-literal/);
  });
  it('clause B1 — 2nd resolver fails (path.resolve, aliased, ?? cwd)', () => {
    for (const body of [
      `import path from 'path';\nexport const r = path.resolve(process.cwd(), '..');\n`,
      `import p from 'path';\nexport const r = p.resolve(process.cwd(), '..');\n`,
      `export const f = (x: any) => x.workDir ?? process.cwd();\n`,
    ]) {
      const dir = fixture({ 'src/main/b.ts': body });
      const { code, out } = runGuard(['--scan-dir', dir]);
      expect(code, `${body}\n${out}`).toBe(1);
      expect(out).toMatch(/B1:2nd-resolver/);
      rmSync(dir, { recursive: true, force: true }); fixtureRoot = null;
    }
  });
  it('clause B2 — renderer fusing repo_path + workDir fails', () => {
    const dir = fixture({ 'src/renderer/c.tsx': `export const w = (a:any,b:any) => b.workDir || a.repo_path || '';\n` });
    const { code, out } = runGuard(['--scan-dir', dir]);
    expect(code, out).toBe(1);
    expect(out).toMatch(/B2:renderer-composes-path/);
  });
  it('clause B3 — a 2nd workspace env var fails', () => {
    const dir = fixture({ 'src/main/d.ts': `export const e = process.env.OTHER_WORKSPACE_ROOT || '';\n` });
    const { code, out } = runGuard(['--scan-dir', dir]);
    expect(code, out).toBe(1);
    expect(out).toMatch(/B3:2nd-workspace-env/);
  });
  it('does NOT false-positive: display / field-default / benign cwd / clean', () => {
    const dir = fixture({
      'src/renderer/disp.tsx': `export const Row = (p:any) => p.repo_path ?? null;\n`,
      'src/renderer/recon.tsx': `export const cfg = (local:any, D:string) => ({ workDir: local?.workDir ?? D });\n`,
      'src/main/benign.ts': `import path from 'path';\nexport const e = path.join(process.cwd(), '.env');\n`,
      'src/main/ok.ts': `export const ok = 1;\n`,
    });
    const { code, out } = runGuard(['--scan-dir', dir]);
    expect(code, out).toBe(0);
  });
});

describe('guard — COL-6 AC4 hardened false-negative classes', () => {
  const caught: Record<string, [string, string, RegExp]> = {
    'fix-a: // inside a URL literal no longer masks B1':
      ['src/main/url.ts', `const u = "http://127.0.0.1:3002"; export const w = (y:any) => y ?? process.cwd();\n`, /B1:2nd-resolver/],
    'fix-b: template-literal process.cwd() path build':
      ['src/main/tpl.ts', 'export const p = `${process.cwd()}/..`;\n', /B1:2nd-resolver/],
    'fix-b: destructured/aliased resolve':
      ['src/main/destr.ts', `import * as path from 'path';\nconst { resolve: R } = path;\nexport const r = R(process.cwd(), '..');\n`, /B1:2nd-resolver/],
    'fix-b: renderer ternary repo_path composition':
      ['src/renderer/tern.tsx', `export const w = (a:any,b:any) => a.repo_path ? a.repo_path : b.workDir;\n`, /B2:renderer-composes-path/],
    'fix-b: renderer repo_path into a path-named var':
      ['src/renderer/asg.tsx', `export const f = (a:any) => { const workDir = a.repo_path; return workDir; };\n`, /B2:renderer-composes-path/],
  };
  for (const [name, [rel, body, clause]] of Object.entries(caught)) {
    it(`CAUGHT — ${name}`, () => {
      const dir = fixture({ [rel]: body });
      const { code, out } = runGuard(['--scan-dir', dir]);
      expect(code, out).toBe(1);
      expect(out).toMatch(clause);
    });
  }
  it('STILL CLEAN — bare URL (no cwd) + renderer repo_path display', () => {
    const dir = fixture({
      'src/main/url2.ts': `export const base = "http://api:3002/v1/mail";\n`,
      'src/renderer/disp2.tsx': `export const Row = (p:any) => p.repo_path ?? null;\n`,
    });
    const { code, out } = runGuard(['--scan-dir', dir]);
    expect(code, out).toBe(0);
  });
});
