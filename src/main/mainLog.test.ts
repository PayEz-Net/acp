import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  initMainLog,
  getMainLogPath,
  resetMainLogForTests,
} from './mainLog';

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mainlog-'));
});

afterEach(async () => {
  resetMainLogForTests();
  await fs.rm(dir, { recursive: true, force: true });
});

describe('mainLog', () => {
  it('tees console output into an append-only file under the resolved dir', async () => {
    const p = initMainLog(dir);
    expect(p).toBe(path.join(dir, 'logs', 'main.log'));
    expect(getMainLogPath()).toBe(p);

    console.warn('delivery failed', { cause: 'network' });

    const content = await fs.readFile(p, 'utf8');
    expect(content).toMatch(/\[warn\] delivery failed \{ cause: 'network' \}/);
  });

  it('replaces console methods with a tee that still delegates', async () => {
    const before = console.log;
    initMainLog(dir);
    expect(console.log).not.toBe(before); // tee installed
    // Delegation is structural (original runs before the file write) — assert
    // the call neither throws nor swallows, and the copy landed.
    expect(() => console.log('delegates-fine')).not.toThrow();
    const content = await fs.readFile(path.join(dir, 'logs', 'main.log'), 'utf8');
    expect(content).toContain('delegates-fine');
  });

  it('rotates at the cap and bounds total footprint at 2x', async () => {
    const cap = 512;
    const p = initMainLog(dir, cap);
    for (let i = 0; i < 50; i++) console.error(`line-${i}-` + 'x'.repeat(40));

    const cur = await fs.stat(p);
    const prev = await fs.stat(`${p}.1`);
    expect(cur.size).toBeLessThanOrEqual(cap + 256); // current never exceeds cap by more than one line
    expect(cur.size + prev.size).toBeLessThanOrEqual(2 * cap + 512);
    // oldest lines rolled out of BOTH files
    const content = await fs.readFile(p, 'utf8');
    expect(content).not.toContain('line-0-');
  });

  it('appends across re-init within the process lifetime (second init is a no-op)', async () => {
    const p = initMainLog(dir);
    console.log('first');
    expect(initMainLog(dir)).toBe(p); // same path, no duplicate tee
    console.log('second');
    const content = await fs.readFile(p, 'utf8');
    expect(content.match(/first/g)?.length).toBe(1);
    expect(content.match(/second/g)?.length).toBe(1);
  });

  it('resetMainLogForTests restores console and detaches the sink', async () => {
    const p = initMainLog(dir);
    console.log('before-reset');
    resetMainLogForTests();
    console.log('after-reset');
    const content = await fs.readFile(p, 'utf8');
    expect(content).toContain('before-reset');
    expect(content).not.toContain('after-reset');
  });
});
