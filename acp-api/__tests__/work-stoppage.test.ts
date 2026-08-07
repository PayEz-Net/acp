/**
 * Kanban 181986 — work-stoppage detection.
 *
 * The monitor is driven synchronously (construct with fakes, call tick() with an
 * injected clock) — the same pattern as wo-liveteam-crash-restart.test.js: no
 * fake timers, no waiting on setInterval. The stamp middleware is exercised
 * directly with mock req/res/next.
 *
 * Acceptance mapping:
 *   1. stall + unworked cards -> exactly one kick        (one kick per episode)
 *   2. silence + clear board -> NO mail                  (earned rest)
 *   3. heartbeat-only traffic -> still counts as silence (stamp exclusions)
 *   4. work resumes -> re-arm; new stall -> new kick     (hysteresis)
 */
import { WorkActivity } from '../api/lifecycle/workActivity.js';
import { WorkStoppageMonitor } from '../api/lifecycle/workStoppageMonitor.js';
import { workActivityStamp } from '../api/middleware/workActivityStamp.js';

const T0 = Date.parse('2026-08-07T12:00:00Z');
const MIN = 60_000;

function makeCfg(overrides = {}) {
  return {
    workStoppageSilenceMinutes: 30,
    workStoppageTickSeconds: 60,
    workStoppageKickFrom: 'BAPert',
    ...overrides,
  };
}

function makeStorage({ projectId = 31, tasks = [{ status: 'backlog' }], throws = false } = {}) {
  return {
    async getActiveProjectId() {
      if (throws) throw new Error('storage down');
      return projectId;
    },
    async listTasks() {
      if (throws) throw new Error('storage down');
      return tasks;
    },
  };
}

function makeKickSender(failOn = []) {
  const calls = [];
  return {
    calls,
    async send(to, subject, body) {
      calls.push({ to, subject, body });
      if (failOn.some((r) => to.includes(r))) throw new Error(`recipient ${to} unknown`);
      return { id: 9000 + calls.length };
    },
  };
}

describe('WorkActivity', () => {
  test('boot seeds the clock — a fresh hub gets one threshold of grace', () => {
    const a = new WorkActivity(T0);
    expect(a.snapshot(T0 + 60_000).silenceSeconds).toBe(60);
  });

  test('record resets silence and attributes per agent', () => {
    const a = new WorkActivity(T0);
    a.record('BAPert', T0 + 10 * MIN);
    const snap = a.snapshot(T0 + 12 * MIN);
    expect(snap.silenceSeconds).toBe(120);
    expect(snap.perAgent.BAPert).toBe(new Date(T0 + 10 * MIN).toISOString());
  });
});

describe('workActivityStamp middleware', () => {
  function run(req) {
    const activity = new WorkActivity(T0);
    let nextCalled = false;
    workActivityStamp(activity)(req, {}, () => {
      nextCalled = true;
    });
    return { activity, nextCalled };
  }

  test('agent-authenticated work call stamps', () => {
    const { activity, nextCalled } = run({
      authMethod: 'agent',
      agentName: 'DotNetPert',
      method: 'GET',
      path: '/v1/kanban/tasks/117200',
    });
    expect(nextCalled).toBe(true);
    expect(activity.snapshot(T0 + MIN).silenceSeconds).toBe(0);
  });

  test('bearer (renderer/human) calls never stamp — human polling is not agent work', () => {
    const { activity } = run({
      authMethod: 'bearer',
      agentName: 'system',
      method: 'GET',
      path: '/v1/mail/inbox/DotNetPert',
    });
    expect(activity.snapshot(T0 + 60 * MIN).silenceSeconds).toBe(3600);
  });

  test('heartbeat / SSE / agent-session paths never stamp (the overnight mask case)', () => {
    for (const path of ['/health', '/v1/sse/stream', '/v1/sse/status', '/v1/agent-sessions/abc/heartbeat']) {
      const { activity } = run({ authMethod: 'agent', agentName: 'BAPert', method: 'GET', path });
      expect(activity.snapshot(T0 + 60 * MIN).silenceSeconds).toBe(3600);
    }
  });

  test('platform mail (UNATTENDED PING / WORK-STOPPAGE kick) never stamps', () => {
    for (const subject of ['UNATTENDED PING: Check kanban and mail', 'WORK-STOPPAGE: team silent 31 min']) {
      const { activity } = run({
        authMethod: 'agent',
        agentName: 'BAPert',
        method: 'POST',
        path: '/v1/mail/send',
        body: { subject },
      });
      expect(activity.snapshot(T0 + 60 * MIN).silenceSeconds).toBe(3600);
    }
  });

  test('a real agent mail send DOES stamp', () => {
    const { activity } = run({
      authMethod: 'agent',
      agentName: 'DotNetPert',
      method: 'POST',
      path: '/v1/mail/send',
      body: { subject: 'DONE 117200: ...' },
    });
    expect(activity.snapshot(T0 + MIN).silenceSeconds).toBe(0);
  });
});

describe('WorkStoppageMonitor', () => {
  function makeMonitor({ storage, kick, activity, cfg } = {}) {
    return new WorkStoppageMonitor(
      makeCfg(cfg),
      storage ?? makeStorage(),
      activity ?? new WorkActivity(T0),
      (kick ?? makeKickSender()).send,
    );
  }

  test('AC1: stall with unworked cards mails exactly ONE kick (no repeat while the stall continues)', async () => {
    const kick = makeKickSender();
    const activity = new WorkActivity(T0);
    const m = makeMonitor({ activity, kick });

    await m.tick(T0 + 31 * MIN); // silence 31m > 30m threshold, board has backlog
    expect(kick.calls.length).toBe(1);
    expect(kick.calls[0].to).toEqual(['JonPert']);
    expect(kick.calls[0].subject).toMatch(/^WORK-STOPPAGE: team silent 31 min, 1 card\(s\) unworked$/);

    await m.tick(T0 + 35 * MIN); // same episode — no second mail
    await m.tick(T0 + 60 * MIN);
    expect(kick.calls.length).toBe(1);
  });

  test('AC2: silence with a CLEAR board is earned rest — no mail', async () => {
    const kick = makeKickSender();
    const m = makeMonitor({
      kick,
      activity: new WorkActivity(T0),
      storage: makeStorage({ tasks: [{ status: 'done' }, { status: 'review' }] }),
    });
    await m.tick(T0 + 90 * MIN);
    expect(kick.calls.length).toBe(0);
  });

  test('no started project on the rig — no mail', async () => {
    const kick = makeKickSender();
    const m = makeMonitor({ kick, activity: new WorkActivity(T0), storage: makeStorage({ projectId: null }) });
    await m.tick(T0 + 90 * MIN);
    expect(kick.calls.length).toBe(0);
  });

  test('board read failure is no-measurement-not-a-red: no mail, no throw, retry next tick', async () => {
    const kick = makeKickSender();
    const flaky = makeStorage({ throws: true });
    const m = makeMonitor({ kick, activity: new WorkActivity(T0), storage: flaky });
    await expect(m.tick(T0 + 90 * MIN)).resolves.toBeUndefined();
    expect(kick.calls.length).toBe(0);

    // Storage recovers — the same stall episode still gets its kick (not suppressed).
    flaky.getActiveProjectId = async () => 31;
    flaky.listTasks = async () => [{ status: 'in_progress' }];
    await m.tick(T0 + 95 * MIN);
    expect(kick.calls.length).toBe(1);
  });

  test('AC4: work resumes after a kick -> monitor re-arms; a NEW stall kicks again', async () => {
    const kick = makeKickSender();
    const activity = new WorkActivity(T0);
    const m = makeMonitor({ activity, kick });

    await m.tick(T0 + 45 * MIN); // stall -> kick #1
    expect(kick.calls.length).toBe(1);

    activity.record('NextPert', T0 + 50 * MIN); // work resumes
    await m.tick(T0 + 55 * MIN); // inside window -> re-arm, no mail
    expect(kick.calls.length).toBe(1);

    await m.tick(T0 + 50 * MIN + 45 * MIN); // new stall -> kick #2
    expect(kick.calls.length).toBe(2);
  });

  test('JonPert undeliverable -> falls back to BAPert', async () => {
    const kick = makeKickSender(['JonPert']);
    const m = makeMonitor({ kick, activity: new WorkActivity(T0) });
    await m.tick(T0 + 45 * MIN);
    expect(kick.calls.map((c) => c.to)).toEqual([['JonPert'], ['BAPert']]);
  });

  test('both recipients undeliverable -> episode NOT marked kicked; next tick retries', async () => {
    const failOn = ['JonPert', 'BAPert'];
    const kick = makeKickSender(failOn); // failOn is read by closure — mutating it simulates recovery
    const m = makeMonitor({ kick, activity: new WorkActivity(T0) });

    await m.tick(T0 + 45 * MIN);
    expect(kick.calls.length).toBe(2); // JonPert attempt + BAPert attempt, both failed

    failOn.length = 0; // delivery recovers
    await m.tick(T0 + 50 * MIN); // same stall episode -> the kick retries and lands
    expect(kick.calls.length).toBe(3);
    expect(kick.calls[2].to).toEqual(['JonPert']);

    await m.tick(T0 + 55 * MIN); // now marked kicked -> silence
    expect(kick.calls.length).toBe(3);
  });

  test('inside the silence threshold: never even reads the board', async () => {
    let boardReads = 0;
    const storage = makeStorage();
    const origList = storage.listTasks;
    storage.listTasks = async (f) => {
      boardReads++;
      return origList(f);
    };
    const m = makeMonitor({ activity: new WorkActivity(T0), storage });
    await m.tick(T0 + 5 * MIN);
    expect(boardReads).toBe(0);
  });
});
