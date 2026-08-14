/**
 * WO-G4 (kanban 117423) — ClaudeStreamJsonTransport tests.
 *
 * The transport adapts Claude's stream-json wire (NOT JSON-RPC) to the
 * AcpProcess-shaped surface AcpRuntimeManager drives. The child is
 * test-fixtures/fake-claude.cjs, a node script mirroring the real CLI's
 * lifecycle (init on start, assistant+result per NDJSON turn, interrupt via
 * control_request, --resume BOGUS → exit 1). No real `claude` binary required.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ClaudeStreamJsonTransport } from './ClaudeStreamJsonTransport';

const FIXTURE = path.join(__dirname, 'test-fixtures', 'fake-claude.cjs');

let dir: string;
let transport: ClaudeStreamJsonTransport | null = null;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'transport-test-'));
});

afterEach(() => {
  transport?.kill();
  transport = null;
  fs.rmSync(dir, { recursive: true, force: true });
});

function makeTransport(extra: Partial<ConstructorParameters<typeof ClaudeStreamJsonTransport>[0]> = {}) {
  transport = new ClaudeStreamJsonTransport({
    agentName: 'NextPert',
    workDir: dir,
    eventStoreDir: dir,
    command: process.execPath, // node
    commandArgsPrefix: [FIXTURE],
    ...extra,
  });
  return transport;
}

interface Notification {
  method: string;
  params: { sessionId?: string; update?: { sessionUpdate?: string; [k: string]: unknown } };
}

function collectNotifications(t: ClaudeStreamJsonTransport): Notification[] {
  const list: Notification[] = [];
  t.on('notification', (method: string, params: Notification['params']) => {
    list.push({ method, params });
  });
  return list;
}

async function waitFor(pred: () => boolean, ms = 5000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 25));
  }
}

/** Bring a transport up through the manager's startOnce handshake. */
async function startSession(t: ClaudeStreamJsonTransport): Promise<string> {
  t.start();
  const init = (await t.request('initialize', {
    protocolVersion: 1,
    capabilities: {},
    clientInfo: { name: 'acp-desktop', version: '1.0.0' },
  })) as { agentCapabilities?: { loadSession?: boolean } };
  expect(init.agentCapabilities?.loadSession).toBe(true);
  const session = (await t.request('session/new', { mcpServers: [], cwd: dir })) as {
    sessionId: string;
  };
  return session.sessionId;
}

describe('ClaudeStreamJsonTransport', () => {
  it('runs the manager handshake: initialize advertises loadSession, session/new yields a session id', async () => {
    const t = makeTransport();
    const sessionId = await startSession(t);
    // Fresh sessions get a client-chosen UUID (--session-id): 2.1.231 defers
    // system/init to the first turn, so the id is knowable only because we chose it.
    expect(sessionId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(t.isRunning()).toBe(true);
  });

  it('session/prompt resolves on the turn result and streams mapped notifications', async () => {
    const t = makeTransport();
    const notifications = collectNotifications(t);
    const sessionId = await startSession(t);

    const result = (await t.request(
      'session/prompt',
      { sessionId, prompt: [{ type: 'text', text: 'hello transport' }] },
      0,
    )) as { stopReason: string };
    expect(result.stopReason).toBe('end_turn');

    const updates = notifications.map((n) => n.params.update?.sessionUpdate);
    expect(updates).toContain('agent_message_chunk');
    expect(updates).toContain('turn_complete');
    const chunks = notifications
      .filter((n) => n.params.update?.sessionUpdate === 'agent_message_chunk')
      .map((n) => JSON.stringify(n.params.update));
    expect(chunks.join('')).toContain('echo:hello transport');
  });

  it('A-2 shape: every renderer-bound frame is a structured session/update — no raw terminal chrome', async () => {
    const t = makeTransport();
    const notifications = collectNotifications(t);
    const sessionId = await startSession(t);
    await t.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'chrome check' }] }, 0);

    expect(notifications.length).toBeGreaterThan(0);
    for (const n of notifications) {
      expect(n.method).toBe('session/update');
      const raw = JSON.stringify(n.params);
      // TUI chrome markers observed on the PTY path must never appear.
      expect(raw).not.toContain('Transcript saving');
      expect(raw).not.toContain('──');
      // eslint-disable-next-line no-control-regex
      expect(raw).not.toMatch(/\x1b\[/);
    }
  });

  it('STREAM turns: token deltas stream once, the whole-message echo does not double the text', async () => {
    const t = makeTransport();
    const notifications = collectNotifications(t);
    const sessionId = await startSession(t);
    await t.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'STREAM:double-check' }] }, 0);

    const texts = notifications
      .filter((n) => n.params.update?.sessionUpdate === 'agent_message_chunk')
      .map((n) => {
        const content = n.params.update?.content as { content?: { text?: string } };
        return content?.content?.text ?? '';
      });
    expect(texts.join('')).toBe('echo:double-check');
  });

  it('A-4: session/cancel PREEMPTS a running turn (interrupt, not queue) and the process survives', async () => {
    const t = makeTransport();
    const notifications = collectNotifications(t);
    const sessionId = await startSession(t);

    // SLOW: turn never finishes on its own — only an interrupt settles it.
    const turn = t.request(
      'session/prompt',
      { sessionId, prompt: [{ type: 'text', text: 'SLOW:never' }] },
      0,
    ) as Promise<{ stopReason: string }>;
    await waitFor(() => t.hasTurnInFlight());

    const t0 = Date.now();
    t.notify('session/cancel', { sessionId });
    const settled = await turn;
    const elapsed = Date.now() - t0;

    // Preempted: resolved fast (no 5s+ drain), cancelled, process alive.
    expect(elapsed).toBeLessThan(3000);
    expect(settled.stopReason).toBe('cancelled');
    expect(t.isRunning()).toBe(true);
    const cancels = notifications.filter(
      (n) => n.params.update?.sessionUpdate === 'turn_complete' && n.params.update?.stopReason === 'cancelled',
    );
    expect(cancels.length).toBeGreaterThan(0);

    // The interrupted turn must NOT surface as an error line in the pane:
    // the trailing result/error_during_execution is swallowed.
    await new Promise((r) => setTimeout(r, 300));
    const errors = notifications.filter((n) => n.params.update?.sessionUpdate === 'error');
    expect(errors).toHaveLength(0);

    // And the transport still serves the NEXT turn (no wedged session).
    const next = (await t.request(
      'session/prompt',
      { sessionId, prompt: [{ type: 'text', text: 'after cancel' }] },
      0,
    )) as { stopReason: string };
    expect(next.stopReason).toBe('end_turn');
  });

  it('session/resume spawns with --resume; an unknown session id rejects so the manager falls back to session/new', async () => {
    const t = makeTransport();
    t.start();
    await t.request('initialize', {});
    await expect(
      t.request('session/resume', { sessionId: 'resumed-uuid-1234', cwd: dir, mcpServers: [] }),
    ).resolves.toBeDefined();
    // The fixture keeps the handed id, so events persist under it from the start.
    await waitFor(() => fs.existsSync(path.join(dir, 'NextPert', 'resumed-uuid-1234.jsonl')));
    expect(t.isRunning()).toBe(true);
  });

  it('session/resume with a BOGUS id rejects (real CLI exits 1) — manager falls back to session/new', async () => {
    const t = makeTransport();
    t.start();
    await t.request('initialize', {});
    await expect(
      t.request('session/resume', { sessionId: 'BOGUS', cwd: dir, mcpServers: [] }),
    ).rejects.toThrow();
    // The fallback then works on the SAME transport.
    const session = (await t.request('session/new', { mcpServers: [], cwd: dir })) as {
      sessionId: string;
    };
    expect(session.sessionId).toBeTruthy();
    expect(session.sessionId).not.toBe('BOGUS');
  });

  it('A-6: kill() tree-kills the child — no orphan, isRunning flips, later requests reject', async () => {
    const t = makeTransport();
    await startSession(t);
    expect(t.isRunning()).toBe(true);
    t.kill();
    await waitFor(() => !t.isRunning());
    await expect(
      t.request('session/prompt', { sessionId: 'x', prompt: [{ type: 'text', text: 'hi' }] }, 0),
    ).rejects.toThrow();
  });

  it('a mid-turn process exit rejects the pending prompt instead of hanging it', async () => {
    const t = makeTransport();
    const sessionId = await startSession(t);
    const turn = t.request(
      'session/prompt',
      { sessionId, prompt: [{ type: 'text', text: 'SLOW:never' }] },
      0,
    );
    await waitFor(() => t.hasTurnInFlight());
    t.kill();
    await expect(turn).rejects.toThrow();
  });

  it('a second prompt mid-turn is written immediately (steer) and resolves without waiting for the turn', async () => {
    const t = makeTransport();
    const sessionId = await startSession(t);
    const turn = t.request(
      'session/prompt',
      { sessionId, prompt: [{ type: 'text', text: 'SLOW:never' }] },
      0,
    ) as Promise<unknown>;
    await waitFor(() => t.hasTurnInFlight());

    const steer = (await t.request(
      'session/prompt',
      { sessionId, prompt: [{ type: 'text', text: 'steer note' }] },
      0,
    )) as { stopReason: string };
    expect(steer.stopReason).toBe('steered');

    // Clean up the still-open turn via interrupt so afterEach's kill is quiet.
    t.notify('session/cancel', { sessionId });
    await turn;
  });

  it('respond() is a no-op (no permission channel — claude runs with the PTY path\'s skip-permissions flag)', async () => {
    const t = makeTransport();
    expect(() => t.respond(1, { outcome: { outcome: 'selected', optionId: 'allow' } })).not.toThrow();
  });
});
