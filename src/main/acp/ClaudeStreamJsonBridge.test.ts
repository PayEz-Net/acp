/**
 * BRIDGE 1 (kanban 117423) — ClaudeStreamJsonBridge transport tests.
 *
 * The child is test-fixtures/fake-claude.cjs, a node script that mirrors the
 * real CLI's stream-json lifecycle (DEFERRED init on the first turn — 2.1.231
 * emits nothing at startup — assistant+result per NDJSON stdin turn, exit 0
 * on EOF). No real `claude` binary required.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ClaudeStreamJsonBridge } from './ClaudeStreamJsonBridge';
import { queryBridgeEvents } from './bridgeEventStore';
import type { ClaudeStreamJsonEvent } from './claudeStreamJson';

const FIXTURE = path.join(__dirname, 'test-fixtures', 'fake-claude.cjs');

let dir: string;
let bridge: ClaudeStreamJsonBridge | null = null;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-test-'));
});

afterEach(() => {
  bridge?.kill();
  bridge = null;
  fs.rmSync(dir, { recursive: true, force: true });
  delete process.env.CLAUDE_CODE_CHILD_SESSION;
});

function makeBridge(extra: Partial<ConstructorParameters<typeof ClaudeStreamJsonBridge>[0]> = {}) {
  bridge = new ClaudeStreamJsonBridge({
    agentName: 'NextPert',
    workDir: dir,
    eventStoreDir: dir,
    command: process.execPath, // node
    commandArgsPrefix: [FIXTURE],
    ...extra,
  });
  return bridge;
}

/** Resolve when pred() is true, polling the event store. */
async function waitFor(pred: () => boolean, ms = 5000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe('ClaudeStreamJsonBridge', () => {
  it('captures the session id from system/init and exposes it', async () => {
    const b = makeBridge();
    const sessions: string[] = [];
    b.on('session', (id: string) => sessions.push(id));
    b.start();
    // Deferred init (2.1.231): init arrives with the FIRST turn, not at spawn.
    b.prompt('trigger init');
    await waitFor(() => b.getSessionId() === 'fake-fixture-session-0001');
    expect(sessions).toEqual(['fake-fixture-session-0001']);
  });

  it('serves a prompt turn and emits the assistant + result events', async () => {
    const b = makeBridge();
    const events: ClaudeStreamJsonEvent[] = [];
    b.on('event', (e: ClaudeStreamJsonEvent) => events.push(e));
    b.start();
    b.prompt('hello bridge');
    await waitFor(() => events.some((e) => e.type === 'result'));
    const assistant = events.find((e) => e.type === 'assistant');
    expect(
      (assistant?.message as { content: { text: string }[] }).content[0].text,
    ).toBe('echo:hello bridge');
  });

  it('PERSISTS every event as it arrives — queryable while the process is live', async () => {
    const b = makeBridge();
    b.start();
    b.prompt('persist me');
    await waitFor(
      () => queryBridgeEvents(dir, 'NextPert').some((s) => s.event.type === 'result'),
    );
    const stored = queryBridgeEvents(dir, 'NextPert');
    expect(stored.map((s) => s.event.type)).toEqual(['system', 'assistant', 'result']);
  });

  it('store SURVIVES the pane being killed', async () => {
    const b = makeBridge();
    b.start();
    b.prompt('then die');
    await waitFor(() =>
      queryBridgeEvents(dir, 'NextPert').some((s) => s.event.type === 'result'),
    );
    b.kill();
    await waitFor(() => !b.isRunning());
    const stored = queryBridgeEvents(dir, 'NextPert');
    expect(stored).toHaveLength(3);
  });

  it('strips CLAUDE_CODE_CHILD_SESSION from the child env (proven child-side)', async () => {
    process.env.CLAUDE_CODE_CHILD_SESSION = '1';
    process.env.CLAUDE_CODE_GIT_BASH_PATH = 'C:\\Program Files\\Git\\bin\\bash.exe';
    const b = makeBridge();
    b.start();
    b.prompt('env probe'); // deferred init: the system event rides the first turn
    await waitFor(() =>
      queryBridgeEvents(dir, 'NextPert').some((s) => s.event.type === 'system'),
    );
    const init = queryBridgeEvents(dir, 'NextPert')[0].event as Record<string, unknown>;
    expect(init.child_session_marker).toBeNull();
    // machine config is NOT session identity — it must pass through
    expect(init.git_bash_path_kept).toBe('C:\\Program Files\\Git\\bin\\bash.exe');
    delete process.env.CLAUDE_CODE_GIT_BASH_PATH;
  });

  it('spawns with --resume when the caller hands a persisted session id', async () => {
    // The fixture mirrors real resume semantics (keeps the handed id), so the
    // session stays put and every event persists under it from the start.
    const b = makeBridge({ resumeSessionId: 'resumed-uuid-1234' });
    expect(b.getSessionId()).toBe('resumed-uuid-1234');
    b.start();
    b.prompt('resume probe'); // deferred init: events start with the first turn
    await waitFor(() => queryBridgeEvents(dir, 'NextPert').length > 0);
    expect(fs.existsSync(path.join(dir, 'NextPert', 'resumed-uuid-1234.jsonl'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'NextPert', 'pre-init.jsonl'))).toBe(false);
    await waitFor(() =>
      queryBridgeEvents(dir, 'NextPert').some((s) => s.event.type === 'system'),
    );
    expect(b.getSessionId()).toBe('resumed-uuid-1234');
  });

  it('prompt on a dead bridge throws instead of writing into the void', () => {
    const b = makeBridge();
    expect(() => b.prompt('nobody home')).toThrow(/dead bridge/);
  });

  it('kill is idempotent and safe with no child', () => {
    const b = makeBridge();
    expect(() => {
      b.kill();
      b.kill();
    }).not.toThrow();
  });
});
