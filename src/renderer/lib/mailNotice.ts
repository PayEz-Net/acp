/**
 * Mail-push notice helpers for the SSE mail path (WO 11444).
 *
 * Two rules baked in here:
 * 1. The notice text is self-instructing — it tells the agent exactly how to
 *    read its inbox and that it must act without waiting for the human.
 * 2. The transcript echo happens ONLY after the runtime accepted the notice
 *    (deliverAcpMailNotice); the pane must never show a notice the agent did
 *    not actually receive. Delivery is retried across the post-restart window
 *    when the agent store is still repopulating.
 */
import type { AcpMailInjectResult } from '@shared/acpTypes';

/** API base the renderer talks to (matches the SSE stream URL in useAcpSse). */
const ACP_API_BASE = 'http://127.0.0.1:3001';

/** Cap for an inlined mail body — keeps injected turns bounded (WO: agents act on content, not pointers). */
export const MAIL_BODY_INLINE_CAP = 4000;

export function buildMailNoticeText(
  agentName: string,
  from: string,
  subject: string,
  id: string | number,
  body?: string,
): string {
  const header = `[ACP Mail] You have a message from ${from}: "${subject}" (id: ${id}).`;
  if (!body) {
    return (
      `${header} Read it NOW with: curl -s "${ACP_API_BASE}/v1/mail/inbox/${agentName}?unread=true" ` +
      `-H "X-ACP-Agent: ${agentName}" and act on actionable messages — do not wait for the human.`
    );
  }
  const trimmed = body.trim();
  const truncated =
    trimmed.length > MAIL_BODY_INLINE_CAP
      ? `${trimmed.slice(0, MAIL_BODY_INLINE_CAP)}\n…(truncated — full text: curl -s "${ACP_API_BASE}/v1/mail/messages/${id}" -H "X-ACP-Agent: ${agentName}")`
      : trimmed;
  return (
    `${header}\n\n${truncated}\n\n` +
    `Act on it per mail discipline — reply via POST ${ACP_API_BASE}/v1/mail/send as ${agentName} if it needs an answer; ` +
    `do not wait for the human.`
  );
}

/**
 * Genuine failure: the agent's runtime is down/unreachable. The mail itself
 * is NOT lost — it sits in the inbox — so say exactly that, with the id so a
 * human can point at it (Jon 2026-08-01: "Delivery failed" that doesn't name
 * the mail and then admits it's waiting in the inbox is just bad communication).
 */
export function buildMailDeliveryFailedText(
  agentName: string,
  id: string | number,
  from: string,
  subject: string,
): string {
  return (
    `[ACP Mail] Delivery failed — agent not reachable. Message ${id} from ${from} ` +
    `("${subject}") is safe in ${ACP_API_BASE}/v1/mail/inbox/${agentName}?unread=true ` +
    `— resend or check it once the agent is back.`
  );
}

/**
 * Intentional defer (WO 11622): the agent is mid-turn and the push was
 * skipped BY DESIGN so the live step is never interrupted. Not a failure —
 * the pane line must say the true thing: WHO was spared the interrupt, which
 * message waits, and that it re-pushes when the turn ends (the deferred-mail
 * re-drive, 2026-08-07). Jon: point at the message itself (agents can read it
 * directly); unread=true only matters at session start — don't mention it.
 */
export function buildMailDeliveryDeferredText(
  agentName: string,
  id: string | number,
  from: string,
  subject: string,
): string {
  return (
    `[ACP Mail] Delivery deferred — ${agentName} is mid-turn; push skipped to avoid interrupting ${agentName}. ` +
    `Message ${id} from ${from} ("${subject}") is parked and will be pushed when the turn ends — ` +
    `or read it now: ${ACP_API_BASE}/v1/mail/messages/${id}.`
  );
}

/** Initial attempt at 500ms (unchanged from the original one-shot), then 2s backoff. */
export const MAIL_NOTICE_DELAYS_MS = [500, 2500, 4500];

export interface AcpMailSurface {
  terminalId?: string;
  sessionId?: string;
}

export interface DeliverAcpMailNoticeDeps {
  /** Re-resolved before every attempt so post-restart repopulation is picked up. */
  getSurface: () => AcpMailSurface;
  /** The actual ACP inject-mail call; resolves the tri-state outcome. */
  inject: (sessionId: string, text: string) => Promise<AcpMailInjectResult>;
  onDelivered: () => void;
  /** The agent is mid-turn — the push was skipped BY DESIGN (not a failure). */
  onDeferred: () => void;
  onFailed: () => void;
  /** Injectable for tests. */
  delaysMs?: number[];
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Dedupe for duplicate SSE mail events (reconnect replays). The PTY poller
 * has always had a seen-set; the renderer path never did (WO 11462 #4).
 * Bounded — when the cap is exceeded the oldest quarter is dropped (Set
 * iterates in insertion order).
 *
 * persistKey (WO 11473): when given, the seen-set is mirrored to
 * sessionStorage so a vite-HMR / page reload (which wipes module state but
 * keeps the webContents session) does not re-deliver every synthesized notice,
 * while a full app restart (fresh sessionStorage) correctly re-notifies
 * unreads that may have landed in the down window.
 */
export function createMailEventDeduper(
  cap = 200,
  persistKey?: string,
): ((agentName: string, id: string | number) => boolean) & { unsee: (agentName: string, id: string | number) => void } {
  const seen = new Set<string>();
  if (persistKey && typeof sessionStorage !== 'undefined') {
    try {
      const raw = sessionStorage.getItem(persistKey);
      if (raw) {
        for (const key of JSON.parse(raw) as string[]) seen.add(key);
      }
    } catch {
      // Corrupt/absent payload — start fresh, never block delivery on storage.
    }
  }
  const persist = () => {
    if (!persistKey || typeof sessionStorage === 'undefined') return;
    try {
      sessionStorage.setItem(persistKey, JSON.stringify([...seen].slice(-cap)));
    } catch {
      // Quota/security errors are non-fatal — dedupe still works in-memory.
    }
  };
  const mark = (agentName: string, id: string | number): boolean => {
    const key = `${agentName}:${id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    if (seen.size > cap) {
      let dropped = 0;
      for (const oldest of seen) {
        seen.delete(oldest);
        if (++dropped >= Math.floor(cap / 4)) break;
      }
    }
    persist();
    return true;
  };
  // Remove an id so a later catch-up may re-fire it (WO 11629): a DEFERRED
  // mail inject (old runtime, busy-reject) must not be pinned as 'seen' —
  // the notice is owed redelivery at the next idle/connect.
  mark.unsee = (agentName: string, id: string | number): void => {
    if (seen.delete(`${agentName}:${id}`)) persist();
  };
  return mark;
}

/** Where a mail notice should go, decided off the LIVE surface first (WO 11472). */
export type MailDeliveryRoute =
  /** Live ACP session (terminalId + sessionId): inject via ACP, provider-agnostic. */
  | 'acp-inject'
  /** Live PTY bridge only: main-side poller / MCP channel delivers out-of-band. */
  | 'pty-echo'
  /** No live surface, injectable registered provider: retry across the restart window. */
  | 'provider-fallback-inject'
  /** No live surface, claude registration: rely on the MCP channel push. */
  | 'provider-fallback-echo';

/**
 * Mail-delivery routing decision. The LIVE surface outranks the REGISTERED
 * provider (WO 11472): team-sync can flip agent.provider mid-session, so a
 * claude-registered agent running in a kimi ACP pane must get the ACP inject,
 * not the MCP-channel assumption. The registered provider is consulted only
 * when no live surface exists at all (restart/repopulation window).
 */
export function decideMailDeliveryRoute(
  live: { terminalId?: string; sessionId?: string },
  injectableProvider: boolean,
): MailDeliveryRoute {
  if (live.terminalId && live.sessionId) return 'acp-inject';
  if (live.terminalId) return 'pty-echo';
  return injectableProvider ? 'provider-fallback-inject' : 'provider-fallback-echo';
}

/**
 * Dedupe key for a mail event. Id-less live events (malformed push payloads)
 * get a synthetic content key so a later id'd catch-up of the same mail
 * doesn't double-notify (WO 11491 minor).
 */
export function mailDedupeKey(
  id: string | number | null | undefined,
  from: string,
  subject: string,
): string {
  return id != null && id !== '?' ? String(id) : `noid:${from}:${subject}`;
}

export interface UnreadNotice {
  agentName: string;
  id: number;
  from: string;
  subject: string;
}

/**
 * Pick the unread messages that need a synthesized delivery notice, scoped to
 * the ACTIVE project (WO 11491 P2): mailboxes are composite-keyed `pid:agent`
 * (bare `agent` when no project) and are never cleared on project switch, so
 * iterating all of them would route a stale-project unread against the
 * current roster. Bare keys are included only when there is no active project.
 */
export function collectUnreadNotices(
  mailboxes: Record<
    string,
    { agent?: string; messages?: Array<{ is_read?: boolean; message_id?: number; from_agent?: string; subject?: string }> }
  >,
  activeProjectId: number | null | undefined,
): UnreadNotice[] {
  const out: UnreadNotice[] = [];
  for (const key of Object.keys(mailboxes)) {
    if (activeProjectId != null ? !key.startsWith(`${activeProjectId}:`) : key.includes(':')) continue;
    const box = mailboxes[key];
    const agentName = box?.agent;
    if (!agentName || !Array.isArray(box.messages)) continue;
    for (const msg of box.messages) {
      if (msg.is_read || msg.message_id == null) continue;
      out.push({
        agentName,
        id: msg.message_id,
        from: msg.from_agent ?? 'unknown',
        subject: msg.subject ?? '(no subject)',
      });
    }
  }
  return out;
}

export interface RenderMailLineWithRetryDeps {
  /** Renders the line; returns false while no visual surface exists yet. */
  render: () => boolean;
  attempts?: number;
  intervalMs?: number;
  setIntervalFn?: typeof setInterval;
  clearIntervalFn?: typeof clearInterval;
}

/**
 * Render a mail line, retrying briefly while the agent's pane is still
 * repopulating after an app restart. Used for the delivery-failed line so the
 * failure becomes visible in the pane instead of only the console
 * (WO 11462 #3).
 */
export function renderMailLineWithRetry({
  render,
  attempts = 5,
  intervalMs = 2000,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
}: RenderMailLineWithRetryDeps): void {
  if (render()) return;
  let count = 0;
  const timer = setIntervalFn(() => {
    count += 1;
    if (render() || count >= attempts) {
      clearIntervalFn(timer);
    }
  }, intervalMs);
}

/**
 * Deliver a mail notice to an ACP agent with bounded retry. A one-shot skip
 * loses mail that arrives in the first seconds after an app restart (no
 * terminalId/sessionId yet); retries bridge that window. onDelivered fires
 * only when the runtime accepted the notice; onDeferred fires as soon as the
 * runtime reports a deliberate mid-turn defer (no retry — the turn will not
 * end inside the retry budget, and the defer is a final, designed outcome);
 * onFailed fires after the last attempt so the pane can show a visible
 * failure instead of a fake notice.
 */
export async function deliverAcpMailNotice(
  text: string,
  deps: DeliverAcpMailNoticeDeps,
): Promise<void> {
  const delays = deps.delaysMs ?? MAIL_NOTICE_DELAYS_MS;
  const sleep = deps.sleep ?? defaultSleep;
  for (const delayMs of delays) {
    await sleep(delayMs);
    const surface = deps.getSurface();
    if (!surface.terminalId || !surface.sessionId) continue;
    let result: AcpMailInjectResult = 'failed';
    try {
      result = await deps.inject(surface.sessionId, text);
    } catch {
      result = 'failed';
    }
    if (result === 'delivered') {
      deps.onDelivered();
      return;
    }
    if (result === 'deferred') {
      deps.onDeferred();
      return;
    }
  }
  deps.onFailed();
}
