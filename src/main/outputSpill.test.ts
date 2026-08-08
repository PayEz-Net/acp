import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  configureSpill,
  resetSpillForTests,
  spillOutput,
  drainSpill,
  spillStats,
} from './outputSpill';

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'spill-'));
  resetSpillForTests();
  configureSpill(dir);
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
  resetSpillForTests();
});

describe('outputSpill', () => {
  it('persists a payload and reports it as spilled, not lost', async () => {
    const r = await spillOutput({ data: 'work output' }, 'key-1', 1000);
    expect(r.result).toBe('spilled');
    expect((await spillStats()).entries).toBe(1);
  });

  it('drains oldest-first and preserves the idempotency key', async () => {
    await spillOutput({ data: 'first' }, 'k1', 1000);
    await spillOutput({ data: 'second' }, 'k2', 2000);

    const seen: Array<[unknown, string]> = [];
    const res = await drainSpill(async (p, k) => { seen.push([p, k]); });

    expect(res.sent).toBe(2);
    expect(res.remaining).toBe(0);
    expect(seen).toEqual([
      [{ data: 'first' }, 'k1'],
      [{ data: 'second' }, 'k2'],
    ]);
  });

  it('stops at the first failure and keeps the rest queued', async () => {
    await spillOutput({ data: 'a' }, 'k1', 1000);
    await spillOutput({ data: 'b' }, 'k2', 2000);
    await spillOutput({ data: 'c' }, 'k3', 3000);

    let calls = 0;
    const res = await drainSpill(async () => {
      calls++;
      if (calls === 2) throw new Error('backend still down');
    });

    // One sent, one failed, the third never attempted — a down backend must not
    // cost one request per queued entry.
    expect(res.sent).toBe(1);
    expect(res.stoppedOnFailure).toBe(true);
    expect(calls).toBe(2);
    expect(res.remaining).toBe(2);
  });

  it('survives an outage across a restart (entries persist on disk)', async () => {
    await spillOutput({ data: 'survives' }, 'k1', 1000);
    resetSpillForTests();          // simulate process exit
    configureSpill(dir);           // ...and restart against the same dir

    const seen: string[] = [];
    const res = await drainSpill(async (_p, k) => { seen.push(k); });
    expect(res.sent).toBe(1);
    expect(seen).toEqual(['k1']);
  });

  it('is BOUNDED: evicts oldest and reports the eviction', async () => {
    resetSpillForTests();
    configureSpill(dir, 200); // tiny cap

    await spillOutput({ data: 'x'.repeat(80) }, 'old', 1000);
    const r = await spillOutput({ data: 'y'.repeat(80) }, 'new', 2000);

    // Overflow must be reported, never silent — a silent cap reads as
    // "nothing was lost", which is the failure mode this module exists to end.
    expect(r.result).toBe('evicted');
    expect(r.evictedBytes).toBeGreaterThan(0);

    const seen: string[] = [];
    await drainSpill(async (_p, k) => { seen.push(k); });
    expect(seen).toEqual(['new']);
  });

  it('reports unavailable when not configured, so callers still count a drop', async () => {
    resetSpillForTests();
    const r = await spillOutput({ data: 'z' }, 'k', 1000);
    expect(r.result).toBe('unavailable');
  });

  it('discards an unreadable entry rather than blocking the queue head', async () => {
    await spillOutput({ data: 'good' }, 'k1', 1000);
    await fs.writeFile(path.join(dir, '000000000000500-000099.json'), '{truncated', 'utf8');

    const seen: string[] = [];
    const res = await drainSpill(async (_p, k) => { seen.push(k); });

    expect(seen).toEqual(['k1']);
    expect(res.remaining).toBe(0);
  });

  // --- 184947: cause/attempts persist on the spilled entry -------------------

  it('persists cause and attempts on the spilled entry (184947)', async () => {
    await spillOutput({ data: 'x' }, 'k1', 1000, 'server-error', 5);
    const files = await fs.readdir(dir);
    const entry = JSON.parse(await fs.readFile(path.join(dir, files[0]), 'utf8'));
    expect(entry.cause).toBe('server-error');
    expect(entry.attempts).toBe(5);
  });

  it('omits cause/attempts entirely when the caller supplies none (back-compat shape)', async () => {
    await spillOutput({ data: 'x' }, 'k1', 1000);
    const files = await fs.readdir(dir);
    const entry = JSON.parse(await fs.readFile(path.join(dir, files[0]), 'utf8'));
    expect('cause' in entry).toBe(false);
    expect('attempts' in entry).toBe(false);
  });

  // --- 140734/184947: classify-driven drain policy ----------------------------

  it('a RETRYABLE failure stops the tick and never counts toward dead-letter, however many ticks it spans', async () => {
    await spillOutput({ data: 'a' }, 'k1', 1000);
    await spillOutput({ data: 'b' }, 'k2', 2000);

    // 20 ticks, all classified retryable — well past the default dead-letter
    // budget of 10 — must never dead-letter or lose the entry.
    let res;
    for (let i = 0; i < 20; i++) {
      res = await drainSpill(async () => { throw new Error('backend down'); }, {
        classify: () => 'retryable',
      });
    }
    expect(res!.deadLettered).toBe(0);
    expect(res!.stoppedOnFailure).toBe(true);
    expect((await spillStats()).entries).toBe(2);
  });

  it('a TERMINAL failure is skipped (not blocking) so later entries still drain the same tick', async () => {
    await spillOutput({ data: 'poison' }, 'k1', 1000);
    await spillOutput({ data: 'good' }, 'k2', 2000);

    const sent: string[] = [];
    const res = await drainSpill(
      async (_p, k) => {
        if (k === 'k1') throw new Error('rejected');
        sent.push(k);
      },
      { classify: () => 'terminal' },
    );

    expect(sent).toEqual(['k2']);
    expect(res.sent).toBe(1);
    expect(res.deadLettered).toBe(0); // one failure, under the attempt budget
  });

  it('dead-letters a TERMINAL entry after exceeding maxDrainAttempts, moving it aside (not deleting)', async () => {
    await spillOutput({ data: 'poison' }, 'k1', 1000);

    let res;
    for (let i = 0; i < 3; i++) {
      res = await drainSpill(async () => { throw new Error('rejected'); }, {
        classify: () => 'terminal',
        maxDrainAttempts: 2,
      });
    }

    expect(res!.deadLettered).toBe(1);
    expect(res!.remaining).toBe(0); // no longer counted in the live queue
    expect((await spillStats()).entries).toBe(0);

    const deadLetterDir = path.join(dir, 'dead-letter');
    const deadFiles = await fs.readdir(deadLetterDir);
    expect(deadFiles).toHaveLength(1);
    const preserved = JSON.parse(await fs.readFile(path.join(deadLetterDir, deadFiles[0]), 'utf8'));
    expect(preserved.payload).toEqual({ data: 'poison' }); // moved, not destroyed
  });

  it('mixed classification: a global outage on the head does not stop a later per-entry rejection from being processed once the head clears', async () => {
    await spillOutput({ data: 'good' }, 'k1', 1000);
    await spillOutput({ data: 'poison' }, 'k2', 2000);

    // Tick 1: head (k1) succeeds, k2 is terminal-rejected but under budget.
    const res1 = await drainSpill(
      async (_p, k) => { if (k === 'k2') throw new Error('rejected'); },
      { classify: () => 'terminal', maxDrainAttempts: 1 },
    );
    expect(res1.sent).toBe(1);
    expect(res1.deadLettered).toBe(0);

    // Tick 2: k2 fails again, now exceeding the budget of 1 -> dead-lettered.
    const res2 = await drainSpill(
      async () => { throw new Error('rejected'); },
      { classify: () => 'terminal', maxDrainAttempts: 1 },
    );
    expect(res2.deadLettered).toBe(1);
    expect((await spillStats()).entries).toBe(0);
  });
});
