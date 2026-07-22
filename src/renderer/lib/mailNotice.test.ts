import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  buildMailDeliveryFailedText,
  buildMailNoticeText,
  collectUnreadNotices,
  createMailEventDeduper,
  decideMailDeliveryRoute,
  deliverAcpMailNotice,
  mailDedupeKey,
  renderMailLineWithRetry,
  MAIL_NOTICE_DELAYS_MS,
} from './mailNotice';

const noSleep = async () => {};
const DELAYS = [1, 2, 3];

describe('buildMailNoticeText', () => {
  it('carries the read-it-now instruction with the agent-scoped curl command', () => {
    const text = buildMailNoticeText('NextPert', 'BAPert', 'WORK ORDER', 11444);
    expect(text).toContain('[ACP Mail] You have a message from BAPert: "WORK ORDER" (id: 11444).');
    expect(text).toContain(
      'curl -s "http://127.0.0.1:3001/v1/mail/inbox/NextPert?unread=true" -H "X-ACP-Agent: NextPert"',
    );
    expect(text).toContain('do not wait for the human');
  });
});

describe('buildMailDeliveryFailedText', () => {
  it('states the failure visibly instead of faking a delivered notice', () => {
    const text = buildMailDeliveryFailedText('NextPert');
    expect(text).toContain('[ACP Mail] Delivery failed');
    expect(text).toContain('/v1/mail/inbox/NextPert?unread=true');
  });
});

describe('deliverAcpMailNotice', () => {
  it('echoes only after the runtime accepts the notice', async () => {
    const onDelivered = vi.fn();
    const onFailed = vi.fn();
    const inject = vi.fn().mockResolvedValue(true);

    await deliverAcpMailNotice('n', {
      getSurface: () => ({ terminalId: 't1', sessionId: 's1' }),
      inject,
      onDelivered,
      onFailed,
      delaysMs: DELAYS,
      sleep: noSleep,
    });

    expect(inject).toHaveBeenCalledTimes(1);
    expect(inject).toHaveBeenCalledWith('s1', 'n');
    expect(onDelivered).toHaveBeenCalledTimes(1);
    expect(onFailed).not.toHaveBeenCalled();
  });

  it('retries while the surface is missing, then delivers once it appears (post-restart window)', async () => {
    const surfaces: Array<{ terminalId?: string; sessionId?: string }> = [
      {},
      { terminalId: 't1' },
      { terminalId: 't1', sessionId: 's1' },
    ];
    let i = 0;
    const onDelivered = vi.fn();
    const onFailed = vi.fn();
    const inject = vi.fn().mockResolvedValue(true);

    await deliverAcpMailNotice('n', {
      getSurface: () => surfaces[Math.min(i++, surfaces.length - 1)],
      inject,
      onDelivered,
      onFailed,
      delaysMs: DELAYS,
      sleep: noSleep,
    });

    // Only the third attempt had a complete surface to inject into.
    expect(inject).toHaveBeenCalledTimes(1);
    expect(onDelivered).toHaveBeenCalledTimes(1);
    expect(onFailed).not.toHaveBeenCalled();
  });

  it('reports failure when the runtime keeps refusing (inject returns false)', async () => {
    const onDelivered = vi.fn();
    const onFailed = vi.fn();
    const inject = vi.fn().mockResolvedValue(false);

    await deliverAcpMailNotice('n', {
      getSurface: () => ({ terminalId: 't1', sessionId: 's1' }),
      inject,
      onDelivered,
      onFailed,
      delaysMs: DELAYS,
      sleep: noSleep,
    });

    expect(inject).toHaveBeenCalledTimes(3);
    expect(onDelivered).not.toHaveBeenCalled();
    expect(onFailed).toHaveBeenCalledTimes(1);
  });

  it('treats a throwing inject as a failed attempt and keeps retrying', async () => {
    const onDelivered = vi.fn();
    const onFailed = vi.fn();
    const inject = vi.fn().mockRejectedValueOnce(new Error('ipc down')).mockResolvedValue(true);

    await deliverAcpMailNotice('n', {
      getSurface: () => ({ terminalId: 't1', sessionId: 's1' }),
      inject,
      onDelivered,
      onFailed,
      delaysMs: DELAYS,
      sleep: noSleep,
    });

    expect(inject).toHaveBeenCalledTimes(2);
    expect(onDelivered).toHaveBeenCalledTimes(1);
    expect(onFailed).not.toHaveBeenCalled();
  });

  it('uses 500ms-then-2s-backoff delays by default (3 attempts)', () => {
    expect(MAIL_NOTICE_DELAYS_MS).toEqual([500, 2500, 4500]);
  });
});

describe('createMailEventDeduper (WO 11462 #4)', () => {
  it('passes the first occurrence and suppresses duplicates per agent+id', () => {
    const seen = createMailEventDeduper();
    expect(seen('NextPert', 11444)).toBe(true);
    expect(seen('NextPert', 11444)).toBe(false);
    // Same id for a different agent is a different event.
    expect(seen('QAPert', 11444)).toBe(true);
  });

  it('stays bounded: oldest entries are dropped beyond the cap', () => {
    const seen = createMailEventDeduper(4);
    seen('a', 1);
    seen('a', 2);
    seen('a', 3);
    seen('a', 4);
    seen('a', 5); // exceeds cap → oldest quarter (1 entry) evicted
    // id 1 was evicted, so it passes again; id 5 is still remembered.
    expect(seen('a', 1)).toBe(true);
    expect(seen('a', 5)).toBe(false);
  });
});

describe('createMailEventDeduper persistence (WO 11473)', () => {
  // The lib guards on `typeof sessionStorage` (renderer-only API); these tests
  // run in a node env, so stub a minimal Storage implementation.
  function mockSessionStorage(): Storage {
    const store = new Map<string, string>();
    return {
      getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
      setItem: (k: string, v: string) => { store.set(k, v); },
      removeItem: (k: string) => { store.delete(k); },
      clear: () => store.clear(),
      key: (i: number) => [...store.keys()][i] ?? null,
      get length() { return store.size; },
    } as Storage;
  }

  beforeEach(() => {
    vi.stubGlobal('sessionStorage', mockSessionStorage());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('survives a simulated page reload: a fresh deduper with the same key suppresses seen ids', () => {
    const first = createMailEventDeduper(200, 'acp.mail.seen');
    expect(first('NextPert', 11472)).toBe(true);

    // New module state (HMR reload) — same storage key.
    const second = createMailEventDeduper(200, 'acp.mail.seen');
    expect(second('NextPert', 11472)).toBe(false);
    expect(second('NextPert', 11473)).toBe(true);
  });

  it('tolerates a corrupt stored payload by starting fresh', () => {
    sessionStorage.setItem('acp.mail.seen', '{not json');
    const seen = createMailEventDeduper(200, 'acp.mail.seen');
    expect(seen('NextPert', 1)).toBe(true);
  });

  it('writes nothing when no persistKey is given', () => {
    const seen = createMailEventDeduper(10);
    seen('NextPert', 1);
    expect(sessionStorage.length).toBe(0);
  });
});

describe('decideMailDeliveryRoute (WO 11472)', () => {
  it('prefers the live ACP session even when the registered provider would not inject', () => {
    // The 11472 bug: registered provider=claude (not injectable) but the agent
    // is actually running in a kimi ACP pane.
    expect(decideMailDeliveryRoute({ terminalId: 't1', sessionId: 's1' }, false)).toBe('acp-inject');
    expect(decideMailDeliveryRoute({ terminalId: 't1', sessionId: 's1' }, true)).toBe('acp-inject');
  });

  it('echoes for a live PTY bridge regardless of provider (poller/MCP delivers)', () => {
    expect(decideMailDeliveryRoute({ terminalId: 't1' }, true)).toBe('pty-echo');
    expect(decideMailDeliveryRoute({ terminalId: 't1' }, false)).toBe('pty-echo');
  });

  it('falls back to the registered provider only when no live surface exists', () => {
    expect(decideMailDeliveryRoute({}, true)).toBe('provider-fallback-inject');
    expect(decideMailDeliveryRoute({}, false)).toBe('provider-fallback-echo');
    expect(decideMailDeliveryRoute({ sessionId: 's1' }, true)).toBe('provider-fallback-inject');
  });
});

describe('mailDedupeKey (WO 11491 minor)', () => {
  it('uses the message id when present', () => {
    expect(mailDedupeKey(11472, 'BAPert', 'WO')).toBe('11472');
    expect(mailDedupeKey('11472', 'BAPert', 'WO')).toBe('11472');
  });

  it('falls back to a content key for id-less events so a later id\'d catch-up doesn\'t double-notify', () => {
    expect(mailDedupeKey('?', 'BAPert', 'WO follow-up')).toBe('noid:BAPert:WO follow-up');
    expect(mailDedupeKey(null, 'BAPert', 'WO follow-up')).toBe('noid:BAPert:WO follow-up');
    expect(mailDedupeKey(undefined, 'BAPert', 'WO follow-up')).toBe('noid:BAPert:WO follow-up');
  });
});

describe('collectUnreadNotices (WO 11491 P2)', () => {
  const mailboxes = {
    '7:NextPert': {
      agent: 'NextPert',
      messages: [
        { is_read: false, message_id: 1, from_agent: 'BAPert', subject: 'active-project unread' },
        { is_read: true, message_id: 2, from_agent: 'BAPert', subject: 'read' },
        { is_read: false, from_agent: 'BAPert', subject: 'no id' },
      ],
    },
    '8:NextPert': {
      agent: 'NextPert',
      messages: [{ is_read: false, message_id: 3, from_agent: 'QAPert', subject: 'stale-project unread' }],
    },
    '8:QAPert': {
      agent: 'QAPert',
      messages: [{ is_read: false, message_id: 4, from_agent: 'BAPert', subject: 'stale-project other agent' }],
    },
    NextPert: {
      agent: 'NextPert',
      messages: [{ is_read: false, message_id: 5, from_agent: 'BAPert', subject: 'bare-key unread' }],
    },
  };

  it('scopes to the active project, skips read + id-less + stale-project messages', () => {
    const notices = collectUnreadNotices(mailboxes, 7);
    expect(notices).toEqual([
      { agentName: 'NextPert', id: 1, from: 'BAPert', subject: 'active-project unread' },
    ]);
  });

  it('includes bare agent keys only when there is no active project', () => {
    const notices = collectUnreadNotices(mailboxes, null);
    expect(notices).toEqual([
      { agentName: 'NextPert', id: 5, from: 'BAPert', subject: 'bare-key unread' },
    ]);
  });

  it('returns nothing when no unread matches the scope', () => {
    expect(collectUnreadNotices(mailboxes, 99)).toEqual([]);
    expect(collectUnreadNotices({}, 7)).toEqual([]);
  });
});

describe('renderMailLineWithRetry (WO 11462 #3)', () => {
  function fakeTimers() {
    const callbacks: Array<() => void> = [];
    const setIntervalFn = ((cb: () => void) => {
      callbacks.push(cb);
      return callbacks.length as unknown as ReturnType<typeof setInterval>;
    }) as typeof setInterval;
    const clearIntervalFn = vi.fn() as unknown as typeof clearInterval;
    return { callbacks, setIntervalFn, clearIntervalFn };
  }

  it('renders immediately when a surface exists — no retry scheduled', () => {
    const { setIntervalFn, clearIntervalFn } = fakeTimers();
    const render = vi.fn().mockReturnValue(true);
    renderMailLineWithRetry({ render, setIntervalFn, clearIntervalFn });
    expect(render).toHaveBeenCalledTimes(1);
    expect(clearIntervalFn).not.toHaveBeenCalled();
  });

  it('retries until the surface appears, then stops', () => {
    const { callbacks, setIntervalFn, clearIntervalFn } = fakeTimers();
    const render = vi.fn().mockReturnValueOnce(false).mockReturnValueOnce(false).mockReturnValue(true);
    renderMailLineWithRetry({ render, setIntervalFn, clearIntervalFn });
    expect(render).toHaveBeenCalledTimes(1); // initial attempt failed
    callbacks[0](); // first retry fails
    callbacks[0](); // second retry succeeds
    expect(render).toHaveBeenCalledTimes(3);
    expect(clearIntervalFn).toHaveBeenCalledTimes(1);
  });

  it('gives up after the configured attempts', () => {
    const { callbacks, setIntervalFn, clearIntervalFn } = fakeTimers();
    const render = vi.fn().mockReturnValue(false);
    renderMailLineWithRetry({ render, attempts: 2, setIntervalFn, clearIntervalFn });
    callbacks[0]();
    callbacks[0]();
    expect(render).toHaveBeenCalledTimes(3); // initial + 2 retries
    expect(clearIntervalFn).toHaveBeenCalledTimes(1);
  });
});
