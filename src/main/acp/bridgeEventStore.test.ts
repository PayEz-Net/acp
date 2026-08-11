/**
 * BRIDGE 1 (kanban 117423) — bridge event store tests.
 *
 * The card's contract: events persist AS THEY ARRIVE, are QUERYABLE within a
 * minute, and the store SURVIVES the pane being killed. A sync append-only
 * JSONL store meets all three by construction; these tests pin the behavior.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  appendBridgeEvent,
  queryBridgeEvents,
  type StoredBridgeEvent,
} from './bridgeEventStore';
import type { ClaudeStreamJsonEvent } from './claudeStreamJson';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-events-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const ev = (type: string, extra: Record<string, unknown> = {}): ClaudeStreamJsonEvent =>
  ({ type, ...extra }) as ClaudeStreamJsonEvent;

describe('appendBridgeEvent', () => {
  it('persists each event synchronously — readable before any close/flush', () => {
    appendBridgeEvent(dir, 'NextPert', 'sess-1', ev('assistant'), new Date('2026-08-11T09:00:00Z'));
    // No handle was ever exposed, so there is nothing to flush: the bytes must
    // already be on disk.
    const file = path.join(dir, 'NextPert', 'sess-1.jsonl');
    const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(1);
    const stored = JSON.parse(lines[0]) as StoredBridgeEvent;
    expect(stored.ts).toBe('2026-08-11T09:00:00.000Z');
    expect(stored.event.type).toBe('assistant');
  });

  it('buckets pre-init events into pre-init.jsonl', () => {
    appendBridgeEvent(dir, 'NextPert', null, ev('system', { subtype: 'hook_started' }));
    expect(fs.existsSync(path.join(dir, 'NextPert', 'pre-init.jsonl'))).toBe(true);
  });

  it('separates sessions into separate files', () => {
    appendBridgeEvent(dir, 'NextPert', 'sess-1', ev('assistant'));
    appendBridgeEvent(dir, 'NextPert', 'sess-2', ev('result'));
    expect(fs.existsSync(path.join(dir, 'NextPert', 'sess-1.jsonl'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'NextPert', 'sess-2.jsonl'))).toBe(true);
  });

  it('sanitizes agent names that contain path-hostile characters', () => {
    appendBridgeEvent(dir, 'Next/Pert:Scout', 'sess-1', ev('assistant'));
    expect(fs.existsSync(path.join(dir, 'Next_Pert_Scout', 'sess-1.jsonl'))).toBe(true);
  });

  it('never throws on IO failure — a store error must not kill a live bridge', () => {
    const errors: unknown[] = [];
    const blocked = path.join(dir, 'NextPert');
    fs.writeFileSync(blocked, 'not a directory');
    expect(() =>
      appendBridgeEvent(dir, 'NextPert', 'sess-1', ev('assistant'), new Date(), (e) => errors.push(e)),
    ).not.toThrow();
    expect(errors).toHaveLength(1);
  });
});

describe('queryBridgeEvents', () => {
  it('returns events across sessions, oldest first', () => {
    appendBridgeEvent(dir, 'NextPert', 'sess-2', ev('result'), new Date('2026-08-11T09:02:00Z'));
    appendBridgeEvent(dir, 'NextPert', 'sess-1', ev('assistant'), new Date('2026-08-11T09:00:00Z'));
    appendBridgeEvent(dir, 'NextPert', null, ev('system'), new Date('2026-08-11T09:01:00Z'));
    const got = queryBridgeEvents(dir, 'NextPert');
    expect(got.map((g) => g.event.type)).toEqual(['assistant', 'system', 'result']);
  });

  it('filters by since and types', () => {
    appendBridgeEvent(dir, 'NextPert', 's', ev('assistant'), new Date('2026-08-11T09:00:00Z'));
    appendBridgeEvent(dir, 'NextPert', 's', ev('result'), new Date('2026-08-11T09:05:00Z'));
    expect(queryBridgeEvents(dir, 'NextPert', { since: '2026-08-11T09:01:00Z' })).toHaveLength(1);
    expect(queryBridgeEvents(dir, 'NextPert', { types: ['result'] })).toHaveLength(1);
    expect(queryBridgeEvents(dir, 'NextPert', { types: ['result'], since: '2026-08-11T09:06:00Z' })).toHaveLength(0);
  });

  it('limit keeps the MOST RECENT events', () => {
    for (let i = 0; i < 5; i++) {
      appendBridgeEvent(dir, 'NextPert', 's', ev('assistant', { n: i }), new Date(2026, 7, 11, 9, i));
    }
    const got = queryBridgeEvents(dir, 'NextPert', { limit: 2 });
    expect(got.map((g) => g.event.n)).toEqual([3, 4]);
  });

  it('returns [] for an agent with no store — absence is not an error', () => {
    expect(queryBridgeEvents(dir, 'NoSuchAgent')).toEqual([]);
  });

  it('skips a torn tail line (kill mid-append) and still returns the rest', () => {
    appendBridgeEvent(dir, 'NextPert', 's', ev('assistant'), new Date('2026-08-11T09:00:00Z'));
    fs.appendFileSync(path.join(dir, 'NextPert', 's.jsonl'), '{"ts":"2026-08-11T09:01:');
    const got = queryBridgeEvents(dir, 'NextPert');
    expect(got).toHaveLength(1);
  });

  it('SURVIVES THE PROCESS: written events outlive the writer (store is files, not memory)', () => {
    appendBridgeEvent(dir, 'NextPert', 's', ev('assistant'), new Date('2026-08-11T09:00:00Z'));
    // Simulate pane death by dropping every reference and re-reading cold.
    const got = queryBridgeEvents(dir, 'NextPert');
    expect(got).toHaveLength(1);
    expect(got[0].event.type).toBe('assistant');
  });
});
