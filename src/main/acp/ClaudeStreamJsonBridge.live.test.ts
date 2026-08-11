/**
 * BRIDGE 1 (kanban 117423) — LIVE probe against the real `claude` binary.
 *
 * SKIPPED unless BRIDGE_LIVE=1 is set: this spawns a real CLI turn (network,
 * model call, seconds of latency) and must never run in the normal suite.
 * Run it deliberately:
 *
 *   BRIDGE_LIVE=1 npx vitest run src/main/acp/ClaudeStreamJsonBridge.live.test.ts
 *
 * It is the repeatable evidence for the card's acceptance line: events from a
 * live Claude process are persisted as they arrive, queryable immediately,
 * and the store survives the process being killed.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ClaudeStreamJsonBridge } from './ClaudeStreamJsonBridge';
import { queryBridgeEvents } from './bridgeEventStore';

const LIVE = process.env.BRIDGE_LIVE === '1';
const WORD = 'PINEAPPLE';

describe.skipIf(!LIVE)('ClaudeStreamJsonBridge LIVE (real claude binary)', () => {
  let dir: string;
  let bridge: ClaudeStreamJsonBridge | null = null;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-live-'));
  });

  afterEach(() => {
    bridge?.kill();
    bridge = null;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it(
    'persists a real turn as it arrives, and the store survives the kill',
    { timeout: 180_000 },
    async () => {
      bridge = new ClaudeStreamJsonBridge({
        agentName: 'BridgeLiveProbe',
        workDir: dir,
        eventStoreDir: dir,
      });
      bridge.start();
      bridge.prompt(`Reply with exactly the word ${WORD} and nothing else.`);

      const start = Date.now();
      const sawResult = () =>
        queryBridgeEvents(dir, 'BridgeLiveProbe').some((s) => s.event.type === 'result');
      while (!sawResult()) {
        if (Date.now() - start > 150_000) throw new Error('no result event within 150s');
        await new Promise((r) => setTimeout(r, 250));
      }

      // 1. Events persisted + queryable immediately (well under one minute).
      const stored = queryBridgeEvents(dir, 'BridgeLiveProbe');
      expect(stored.some((s) => s.event.type === 'system')).toBe(true);
      const assistantText = JSON.stringify(
        stored.filter((s) => s.event.type === 'assistant').map((s) => s.event),
      );
      expect(assistantText).toContain(WORD);

      // 2. Session id captured from the live stream.
      const sessionId = bridge.getSessionId();
      expect(sessionId).toBeTruthy();
      expect(
        fs.existsSync(path.join(dir, 'BridgeLiveProbe', `${sessionId}.jsonl`)),
      ).toBe(true);

      // 3. The store survives the pane being killed.
      bridge.kill();
      const after = queryBridgeEvents(dir, 'BridgeLiveProbe');
      expect(after.length).toBe(stored.length);
    },
  );
});
