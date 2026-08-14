/**
 * WO-G4 (kanban 117423) — LIVE manager-level acceptance for the Claude
 * stream-json path. Drives AcpRuntimeManager against the REAL `claude`
 * binary (no PTY) and observes the A-1/A-2/A-4/A-6/A-7 behaviors from the
 * manager's own event stream — the same stream the renderer consumes.
 *
 * SKIPPED unless BRIDGE_LIVE=1: spawns real CLI turns (network, model
 * latency, token cost). Never runs in the normal suite.
 *
 *   BRIDGE_LIVE=1 npx vitest run src/main/acp/AcpRuntimeManager.claude.live.test.ts
 *
 * A-3 (boot payload bytes) is measured separately by .tmp/probe-a3-boot-bytes.cjs.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AcpRuntimeManager } from './AcpRuntimeManager';
import { getProviderConfig } from './providerConfigs';
import type { AcpEventPayload } from '../../shared/acpTypes';

const LIVE = process.env.BRIDGE_LIVE === '1';

// electron: userData redirects into the probe's temp dir (bridge event store).
vi.mock('electron', () => ({
  app: { getPath: () => process.env.BRIDGE_LIVE_USERDATA ?? os.tmpdir() },
  BrowserWindow: class {},
}));

// Platform side-channels stay mocked: this probe must not register sessions
// or fetch identity/mail against the live platform.
vi.mock('../acp-api-client', () => ({
  acpApiGetAgentProfile: vi.fn().mockResolvedValue(null),
  acpApiGetUnreadMailCount: vi.fn().mockResolvedValue(0),
}));
vi.mock('../agentSessionLifecycle', () => ({
  startAgentSession: vi.fn().mockResolvedValue({ ok: true }),
  endAgentSession: vi.fn().mockResolvedValue(undefined),
}));

const mockSettings = vi.hoisted(() => ({
  data: { acpSessionIds: {} as Record<string, string> },
}));
vi.mock('../store', () => ({
  getSettings: vi.fn(() => ({ acpSessionIds: mockSettings.data.acpSessionIds })),
  setSettings: vi.fn((patch: Record<string, unknown>) => {
    if ('acpSessionIds' in patch) {
      mockSettings.data.acpSessionIds = patch.acpSessionIds as Record<string, string>;
    }
  }),
}));

function updates(events: AcpEventPayload[]): string[] {
  return events.map((e) => e.update?.sessionUpdate ?? '');
}

function messageText(events: AcpEventPayload[]): string {
  return events
    .filter((e) => e.update?.sessionUpdate === 'agent_message_chunk')
    .map((e) => {
      const content = (e.update as { content?: { content?: { text?: string } } }).content;
      return content?.content?.text ?? '';
    })
    .join('');
}

async function waitFor(pred: () => boolean, ms: number, label: string): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error(`waitFor timed out: ${label}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

describe.skipIf(!LIVE)('AcpRuntimeManager + Claude stream-json LIVE (real claude binary)', () => {
  let dir: string;
  let manager: AcpRuntimeManager | null = null;
  let events: AcpEventPayload[] = [];

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mgr-live-'));
    process.env.BRIDGE_LIVE_USERDATA = dir;
  });

  afterAll(() => {
    manager?.kill();
    manager = null;
    fs.rmSync(dir, { recursive: true, force: true });
    delete process.env.BRIDGE_LIVE_USERDATA;
  });

  it(
    'A-1/A-2/A-4/A-7/A-6: start, stream, zero chrome, preempting cancel, injectMail, kill+restart resume',
    { timeout: 300_000 },
    async () => {
      manager = new AcpRuntimeManager('live-claude-g4', getProviderConfig('claude'), {
        agentName: 'G4LiveProbe',
        workDir: dir,
      });
      manager.on('event', (p: AcpEventPayload) => events.push(p));
      await manager.start();
      expect(manager.isInitialized()).toBe(true);
      const sessionId = manager.getSessionId();
      expect(sessionId).toBeTruthy();

      // The fresh-session onboarding kickoff fires a real turn by itself —
      // let it settle before we drive our own (A-1 observes streaming on a
      // turn WE sent, not the boot turn).
      await waitFor(
        () => updates(events).includes('turn_complete'),
        120_000,
        'onboarding turn_complete',
      );

      // ---- A-1: prompt streams a reply through the manager contract.
      const base = events.length;
      await manager.prompt('Reply with exactly the word PINEAPPLE and nothing else.');
      await waitFor(
        () => events.slice(base).some((e) => e.update?.sessionUpdate === 'turn_complete'),
        120_000,
        'A-1 turn_complete',
      );
      const a1 = events.slice(base);
      expect(updates(a1)).toContain('agent_message_chunk');
      expect(messageText(a1)).toContain('PINEAPPLE');

      // ---- A-2: zero TUI chrome anywhere in the event stream so far.
      const raw = JSON.stringify(events);
      expect(raw).not.toContain('Transcript saving');
      expect(raw).not.toContain('──');
      // eslint-disable-next-line no-control-regex
      expect(raw).not.toMatch(/\x1b\[/);

      // ---- A-4: cancel PREEMPTS a running turn.
      const cBase = events.length;
      void manager.prompt('Count from 1 to 500 slowly, one number per line.');
      await waitFor(
        () =>
          events.slice(cBase).some((e) => e.update?.sessionUpdate === 'agent_message_chunk'),
        60_000,
        'A-4 first chunk of the long turn',
      );
      const t0 = Date.now();
      manager.cancel();
      await waitFor(
        () =>
          events
            .slice(cBase)
            .some((e) => e.update?.sessionUpdate === 'turn_complete'),
        30_000,
        'A-4 turn_complete after cancel',
      );
      const elapsed = Date.now() - t0;
      const cancelComplete = events
        .slice(cBase)
        .find((e) => e.update?.sessionUpdate === 'turn_complete');
      expect(elapsed).toBeLessThan(15_000); // preempted, not drained
      expect(manager.isInitialized()).toBe(true); // process survived
      console.log(`A-4 cancel settled in ${elapsed}ms, stopReason=${(cancelComplete?.update as { stopReason?: string })?.stopReason}`);

      // ---- A-7: mail injection dispatches on the claude path.
      const injected = await manager.injectMail('[ACP Mail test] WO-G4 A-7 probe — no reply needed.');
      expect(injected).toBe(true);

      // ---- A-6: kill, then restart resumes the SAME session (no orphan:
      // the transport tree-kills; a wedged child would fail --resume's lock).
      await waitFor(
        () => events.slice(events.length - 40).some((e) => e.update?.sessionUpdate === 'turn_complete'),
        120_000,
        'A-7 mail turn settle',
      ).catch(() => { /* a steered mail notice may not close a turn of its own */ });
      manager.kill();
      await manager.restart();
      expect(manager.isInitialized()).toBe(true);
      expect(manager.getSessionId()).toBe(sessionId);

      // And the restarted session still serves a turn.
      const rBase = events.length;
      await manager.prompt('Reply with exactly the word MANGO and nothing else.');
      await waitFor(
        () => events.slice(rBase).some((e) => e.update?.sessionUpdate === 'turn_complete'),
        120_000,
        'post-restart turn_complete',
      );
      expect(messageText(events.slice(rBase))).toContain('MANGO');

      // Final A-2 sweep over the WHOLE session including the restart.
      const all = JSON.stringify(events);
      expect(all).not.toContain('Transcript saving');
      expect(all).not.toContain('──');
      // eslint-disable-next-line no-control-regex
      expect(all).not.toMatch(/\x1b\[/);
    },
  );
});
