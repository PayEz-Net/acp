import { useEffect, useRef } from 'react';
import { IDP_CLIENT_APP, IDP_CLIENT_APP_HEADER } from '@shared/idp-config';
import { useAppStore } from '../stores/appStore';
import { useMailStore } from '../stores/mailStore';
import { usePartyStore } from '../stores/partyStore';
import { useAutonomyStore } from '../stores/autonomyStore';
import { useKanbanStore } from '../stores/kanbanStore';
import { useChatStore } from '../stores/chatStore';
import { useContractorStore } from '../stores/contractorStore';
import { useProjectStore } from '../stores/projectStore';
import { useCheckinStore } from '../stores/checkinStore';
import { useAgentOutputStore } from '../stores/agentOutputStore';
import { useAcpSessionStore } from '../stores/acpSessionStore';
import { resolveAgentProvider, shouldInjectMailToPty } from '../lib/agentProviders';
import {
  buildMailDeliveryFailedText,
  buildMailDeliveryDeferredText,
  buildMailNoticeText,
  createMailEventDeduper,
  decideMailDeliveryRoute,
  deliverAcpMailNotice,
  mailDedupeKey,
  renderMailLineWithRetry,
} from '../lib/mailNotice';

/**
 * Render a mail-related line into the agent's visible surface (ACP transcript
 * user-turn, or a PTY-stream info line). Used for the delivered-notice echo
 * and the delivery-failed line — never before actual delivery (WO 11444).
 * Returns false when the agent has no visible surface yet (post-restart
 * repopulation window) so callers can retry instead of losing the line.
 * Isolated try/catch: a visual-rendering bug must never stop the mail push.
 */
function renderMailSurfaceLine(agentName: string, text: string): boolean {
  const acpSession = useAcpSessionStore.getState().sessions.get(agentName);
  const agentState = useAppStore.getState().agents.find((a) => a.name === agentName);
  try {
    if (acpSession?.sessionId) {
      useAcpSessionStore.getState().startUserTurn(agentName, acpSession.sessionId, text);
      return true;
    }
    if (agentState?.terminalId) {
      useAgentOutputStore.getState().addLine({
        agent: agentName,
        terminal_id: agentState.terminalId,
        line: text,
        ts: new Date().toISOString(),
        source: 'info',
      });
      return true;
    }
    console.warn(`[AcpSse] No visual surface available for ${agentName}; cannot render mail line`);
    return false;
  } catch (visualErr) {
    console.error(`[AcpSse] Visual mail line failed for ${agentName}:`, visualErr);
    return false;
  }
}

// Dedupe duplicate mail events across SSE reconnects (WO 11462 #4), persisted
// across page reloads so an HMR reload doesn't re-deliver everything (WO 11473).
const markMailEventSeen = createMailEventDeduper(200, 'acp.mail.seen');

// Turn-stack defense (Jon 2026-08-01): the SSE catch-up replays recent mail
// events 1:1 into every fresh session, burying agents under history they
// already processed (50-turn boot holes, measured twice in one day). Message
// ids are chronological, so ONE cheap watermark kills the replay: on first
// contact per agent, read the newest message id exactly once; only mail
// ABOVE that id is allowed to inject. Historical events never fire a turn.
const mailWatermark = new Map<string, number>();
const watermarkPending = new Set<string>();

// Boot grace (Jon 2026-08-01): mail injected into an agent that has not
// finished booting is the same turn-stack disease at a different stage —
// the notice queues ahead of the agent's own settling. Mail is durable;
// it can wait. Suppress injection for GRACE_MS after an agent first
// appears; after that, live mail flows normally.
const BOOT_GRACE_MS = 60_000;
let sseConnectedAt: number | null = null;
function inBootGrace(): boolean {
  return sseConnectedAt != null && Date.now() - sseConnectedAt < BOOT_GRACE_MS;
}
async function initMailWatermark(agentName: string): Promise<void> {
  try {
    const headers: Record<string, string> = { 'X-ACP-Agent': agentName };
    const secret = await getSecret();
    if (secret) headers['Authorization'] = `Bearer ${secret}`;
    const res = await fetch(`http://127.0.0.1:3001/v1/mail/inbox/${agentName}?sort=newest&limit=1`, { headers });
    if (!res.ok) return;
    const json = (await res.json()) as { data?: { messages?: Array<{ message_id?: number }> } };
    const msgs = json?.data?.messages ?? [];
    const maxId = msgs.reduce((m, x) => Math.max(m, x?.message_id ?? 0), 0);
    mailWatermark.set(agentName, maxId);
    console.log(`[AcpSse] mail watermark ${agentName}: ${maxId} — older is history, suppressed`);
  } catch {
    // Leave unset — the next event retries. Better to suppress a live mail
    // for a second than to open the historical flood.
  } finally {
    watermarkPending.delete(agentName);
  }
}

/**
 * Fetch a mail message's body so the notice can carry the CONTENT, not just a
 * "go read it" pointer (Jon: agents see alerts but don't go read them — bring
 * the mail to the agent). Returns null on any failure; the caller falls back
 * to the pointer-only notice.
 */
async function fetchMailBody(agentName: string, id: string | number): Promise<string | null> {
  try {
    const headers: Record<string, string> = { 'X-ACP-Agent': agentName };
    const secret = await getSecret();
    if (secret) headers['Authorization'] = `Bearer ${secret}`;
    const res = await fetch(`http://127.0.0.1:3001/v1/mail/messages/${id}`, { headers });
    if (!res.ok) return null;
    const json = (await res.json()) as { data?: { body?: unknown } };
    const body = json?.data?.body;
    return typeof body === 'string' && body.trim().length > 0 ? body : null;
  } catch {
    return null;
  }
}

/**
 * Deliver a mail notice to an agent, routed off the LIVE surface first
 * (WO 11472): a claude-registered agent sitting in a kimi ACP pane must get
 * the ACP inject — team-sync can flip the registered provider mid-session,
 * the pane the agent actually runs in is the truth. The registered provider
 * is consulted only when no live surface exists (restart window).
 *
 * Exported for the wiring tests (WO 11517) — not part of the hook's API.
 */
export async function routeMailNotice(agentName: string, from: string, subject: string, id: string | number): Promise<void> {
  const body = typeof id === 'number' ? await fetchMailBody(agentName, id) : null;
  const noticeText = buildMailNoticeText(agentName, from, subject, id, body ?? undefined);
  const agentState = useAppStore.getState().agents.find((a) => a.name === agentName);
  const acpSession = useAcpSessionStore.getState().sessions.get(agentName);

  const provider = resolveAgentProvider(
    agentState,
    useProjectStore.getState().activeProject?.runtime_choice,
    useAppStore.getState().settings?.agentProvider,
  );
  const route = decideMailDeliveryRoute(
    { terminalId: agentState?.terminalId, sessionId: acpSession?.sessionId },
    shouldInjectMailToPty(provider),
  );
  console.log(`[AcpSse] Mail route for ${agentName}: ${route} (terminalId=${agentState?.terminalId ?? '-'} session=${acpSession?.sessionId ?? '-'} provider=${provider} live=${agentState?.runtimeProvider ?? '-'} registered=${agentState?.provider ?? '-'})`);

  if (route === 'acp-inject' || route === 'provider-fallback-inject') {
    // Deliver via inject-mail with bounded retry; echo into the transcript
    // ONLY when the runtime accepted the notice — the pane must never show a
    // notice the agent did not receive (WO 11444). The retry loop re-resolves
    // the surface on every attempt, covering the post-restart window.
    void deliverAcpMailNotice(noticeText, {
      getSurface: () => ({
        terminalId: useAppStore.getState().agents.find((a) => a.name === agentName)?.terminalId,
        sessionId: useAcpSessionStore.getState().sessions.get(agentName)?.sessionId,
      }),
      inject: (sessionId, text) =>
        window.electronAPI.injectAcpMail({ agent: agentName, sessionId, text }),
      onDelivered: () => renderMailSurfaceLine(agentName, noticeText),
      onDeferred: () => {
        // Mid-turn defer (WO 11622): the push was skipped BY DESIGN — the
        // pane line must say that, not cry failure. Unsee the id so a future
        // re-delivery path may re-fire the notice (WO 11629).
        console.log(`[AcpSse] Mail notice deferred for ${agentName} (mid-turn; mail waits in inbox)`);
        markMailEventSeen.unsee(agentName, mailDedupeKey(id, from, subject));
        markMailEventSeen.unsee(agentName, mailDedupeKey(null, from, subject));
        const deferredText = buildMailDeliveryDeferredText(agentName, id, from, subject);
        renderMailLineWithRetry({
          render: () => renderMailSurfaceLine(agentName, deferredText),
        });
      },
      onFailed: () => {
        console.warn(`[AcpSse] Mail notice delivery failed for ${agentName} after all retries`);
        // WO 11629: unsee the id so a future re-delivery path may RE-FIRE
        // this notice — a deferred mail (old runtime, busy-reject) must not
        // get stuck between 'already seen' and a delivery that never landed.
        // (The catch-up synthesis that used to re-fire these was removed
        // 2026-08-01; live SSE events remain the only notice source.)
        // Both key forms, mirroring the live event path.
        markMailEventSeen.unsee(agentName, mailDedupeKey(id, from, subject));
        markMailEventSeen.unsee(agentName, mailDedupeKey(null, from, subject));
        // The pane may still be repopulating post-restart — retry briefly so
        // the failure is visible there, not just in the console (WO 11462 #3).
        const failureText = buildMailDeliveryFailedText(agentName, id, from, subject);
        renderMailLineWithRetry({
          render: () => renderMailSurfaceLine(agentName, failureText),
        });
      },
    });
    return;
  }

  // pty-echo / provider-fallback-echo: the main-process inbox poller (kimi/codex)
  // or the MCP channel (claude) delivers out-of-band AND already prints the
  // human-visible "[ACP Mail] New message from …" chat line in the pane (pty.ts).
  // The SSE hook USED to also paint a second "You have a message from …" echo box
  // here — a redundant duplicate notice that, with a 7-agent team, firehosed the
  // pane and slid under the UI. Removed (Jon 2026-08-05): keep the chat notice
  // (pty.ts), drop the duplicate box. Delivery is unaffected — this route never
  // delivered, it only echoed; the acp-inject route above still delivers + echoes.
}

/**
 * Centralized SSE hook — single connection to acp-api, multiplexed by agent.
 * Replaces per-pane useMailPush (Phase 1b).
 *
 * Events from acp-api:
 *   event: mail    data: { agent, message_id, from_agent, subject, ... }
 *   event: ping    data: {}
 */

interface SseMailEvent {
  agent: string;
  message_id?: number;
  from_agent?: string;
  from?: string;
  subject?: string;
}

export type SseConnectionState = 'connected' | 'reconnecting' | 'disconnected';

// Cache the local secret
let secretCache: string | null = null;

async function getSecret(): Promise<string | null> {
  if (secretCache) return secretCache;
  if (window.electronAPI?.getLocalSecret) {
    try {
      secretCache = await window.electronAPI.getLocalSecret();
      return secretCache;
    } catch { /* fall through */ }
  }
  return null;
}

/**
 * Single SSE connection to acp-api /v1/sse/stream.
 * Routes mail events to the correct agent's PTY pane.
 * Call once at App level (not per-pane).
 */
export function useAcpSse() {
  const abortRef = useRef<AbortController | null>(null);
  const backendAvailable = useAppStore(s => s.backendAvailable);
  // Data-driven agent roster: reconnect SSE when the set of configured agents
  // changes so the sidecar subscribes the upstream SignalR connection to the
  // right recipients (and never to stale/removed agents like Aurum).
  const agents = useAppStore(s => s.agents);
  const agentNamesKey = agents.map(a => a.name).sort().join(',');
  const connectionStateRef = useRef<SseConnectionState>('disconnected');
  const lastPingRef = useRef<number>(0);
  // P0: don't let the initial transient backendAvailable=false (before App.tsx
  // finishes the async IPC status handshake) permanently gate the first connect.
  // The backend can already be listening on :3001 while the renderer state is
  // still false; attempting once and letting the fetch fail/retry is safer than
  // missing the first push window.
  const hasAttemptedConnection = useRef(false);
  // StrictMode/idempotence guard: prevents a second effect invocation from
  // starting another connect while the first is still in flight.
  const connectingRef = useRef(false);

  useEffect(() => {
    console.log(`[AcpSse] Effect fired — backendAvailable: ${backendAvailable}`);

    // Idempotency guard: only one active SSE connection at a time. React's
    // cleanup runs before the next effect invocation, so in normal lifecycles
    // abortRef is null here. This catches pathological cases (e.g. rapid
    // re-renders before cleanup) and prevents duplicate connections.
    if (abortRef.current && !abortRef.current.signal.aborted) {
      console.log('[AcpSse] Connection already active; skipping duplicate connect');
      return;
    }

    if (connectingRef.current) {
      console.log('[AcpSse] Connect already in flight; skipping duplicate connect');
      return;
    }

    // #225: surface connection state to the mail store so MailSidebar can show
    // a reconnecting/offline indicator (the silent-freeze fix, on the LIVE SSE
    // path — the SignalR client was dead code). Writes both the ref (used by
    // the stale-ping watchdog) and the store (UI).
    const setConn = (s: SseConnectionState) => {
      connectionStateRef.current = s;
      useMailStore.getState().setPushConnectionState(s);
    };

    // #225: full catch-up on reconnect — fetch every configured agent's inbox
    // so messages missed while disconnected appear immediately in the sidebar,
    // not only on the next per-event push. Scoped to active project + gated on
    // boot confirm, same as the per-event path. Promise.resolve().then wraps
    // it so a non-promise short-return from the store (cooldown/429-backoff
    // bare `return;` paths) can never throw a TypeError into the SSE error
    // path (WO 11491 P1).
    const catchUp = (): Promise<void> =>
      Promise.resolve().then(() => {
        if (!useProjectStore.getState().pickerHasStarted) return;
        const projectId = useProjectStore.getState().activeProject?.id;
        // P0 (task #11): ONE aggregated + guarded refetch on reconnect — not a
        // per-agent fan-out (that was part of the 429 storm). fetchAllInboxes
        // coalesces with the other triggers + uses DnP's /v1/mail/inboxes.
        const agents = useAppStore.getState().agents.map((a) => a.name);
        return useMailStore.getState().fetchAllInboxes(agents, projectId);
      });

    if (!backendAvailable && hasAttemptedConnection.current) {
      console.log('[AcpSse] Skipping — backend not available');
      setConn('disconnected');
      connectingRef.current = false;
      return;
    }

    connectingRef.current = true;
    let disposed = false;
    abortRef.current = new AbortController();
    let retryCount = 0;

    // P0: Stale ping watchdog — force reconnect if no ping for 60s
    const STALE_PING_MS = 60_000;
    const pingWatchdog = setInterval(() => {
      if (disposed) return;
      const last = lastPingRef.current;
      if (last > 0 && Date.now() - last > STALE_PING_MS && connectionStateRef.current === 'connected') {
        console.warn(`[AcpSse] No ping for ${Math.round((Date.now() - last) / 1000)}s — forcing reconnect`);
        abortRef.current?.abort();
        abortRef.current = new AbortController();
        connect();
      }
    }, 15_000);

    async function connect() {
      if (disposed) return;
      // Mark that we've attempted a connection so subsequent effect runs with a
      // transient backendAvailable=false will skip instead of retrying forever.
      hasAttemptedConnection.current = true;
      // This connection OWNS its controller. Any path that replaces abortRef
      // (ping watchdog, teardown) makes THIS connect stale — every exit/retry
      // path below re-checks ownership before touching shared state, so a
      // doomed connection can never abort the live one or stack a duplicate
      // stream (WO 11517 P1).
      const myCtrl = new AbortController();
      abortRef.current = myCtrl;
      // P3: No hard retry limit — exponential backoff with 30s cap, never give up
      const secret = await getSecret();
      const headers: Record<string, string> = {
        'Accept': 'text/event-stream',
        [IDP_CLIENT_APP_HEADER]: IDP_CLIENT_APP,
      };
      if (secret) {
        headers['Authorization'] = `Bearer ${secret}`;
      }

      const projectId = useProjectStore.getState().activeProject?.id;
      const agents = useAppStore.getState().agents.map((a) => a.name);
      const params = new URLSearchParams();
      if (agents.length > 0) params.set('agents', agents.join(','));
      if (projectId != null) params.set('project_id', String(projectId));
      const url = `http://127.0.0.1:3001/v1/sse/stream${params.toString() ? '?' + params.toString() : ''}`;
      console.log(`[AcpSse] Connecting... (attempt ${retryCount + 1})`);
      setConn('reconnecting');

      try {
        const response = await fetch(url, { headers, signal: myCtrl.signal });

        if (!response.ok) {
          console.error(`[AcpSse] Connection failed: ${response.status}`);
          // A 401 here is the LOCAL sidecar-secret check (not IDP auth-death). It
          // means the cached secret is stale/wrong — the sidecar respawned with a
          // fresh secret, or we cached a value before main had generated it.
          // INVALIDATE the cache so the next attempt re-pulls the CURRENT live
          // secret from main (getLocalSecret); otherwise getSecret() keeps handing
          // back the same stale token and we loop on 401 forever ("Invalid bearer
          // token" retry storm → Mail OFFLINE, Ryan repro).
          if (response.status === 401) {
            secretCache = null;
          }
          // #225: surface a DISTINCT 'disconnected' (visible "Offline") rather
          // than leaving the optimistic 'reconnecting' spin invisible. KEEP
          // retrying (IDP auth-death is handled separately via
          // AUTH_SESSION_DEAD → LoginScreen).
          setConn('disconnected');
          retryCount++;
          const delay = Math.min(2000 * Math.pow(2, retryCount - 1), 30000) + Math.random() * 1000;
          // Retry only while THIS connection is still the live one — a stale
          // connect must not stack onto the watchdog's replacement (WO 11517).
          setTimeout(() => { if (!disposed && abortRef.current === myCtrl) connect(); }, delay);
          return;
        }

        const reader = response.body?.getReader();
        if (!reader) return;

        const decoder = new TextDecoder();
        let buffer = '';

        console.log('[AcpSse] Connected');
        setConn('connected');
        // #225: catch up on anything missed while down — the inbox refetch
        // feeds the MailSidebar only. The unread→notice synthesis that used to
        // run here (WO 11473) was removed 2026-08-01 (Jon): it replayed the
        // backlog as mail turns and buried fresh sessions before they finished
        // booting; session resume already carries the agent's context.
        void catchUp().catch(() => {});
        retryCount = 0;
        lastPingRef.current = Date.now(); // treat connect as implicit ping

        while (true) {
          const { done, value } = await reader.read();
          if (done || disposed) break;

          buffer += decoder.decode(value, { stream: true });
          const events = buffer.split('\n\n');
          buffer = events.pop() || '';

          for (const eventBlock of events) {
            const lines = eventBlock.split('\n');
            let eventType = '';
            let data = '';

            for (const line of lines) {
              if (line.startsWith('event: ')) eventType = line.slice(7).trim();
              else if (line.startsWith('data: ')) data += line.slice(6);
              else if (line.startsWith('data:')) data += line.slice(5);
            }

            if (eventType === 'ping') {
              lastPingRef.current = Date.now();
              continue;
            }

            if (eventType === 'mail' && data) {
              try {
                const mail: SseMailEvent = JSON.parse(data);
                const agentName = mail.agent;
                if (!agentName) continue;

                const id = mail.message_id ?? '?';
                const from = mail.from_agent ?? mail.from ?? 'unknown';
                const subject = mail.subject ?? '(no subject)';

                // Boot grace: a fresh SSE connection means the world is still
                // settling. Mail waits in the inbox, durable.
                if (inBootGrace()) {
                  console.log(`[AcpSse] boot grace: holding mail for ${agentName} (<60s since SSE connect)`);
                  continue;
                }

                // Turn-stack gate: only mail NEWER than the agent's watermark
                // may inject. Everything else is catch-up replay — suppressed
                // without firing a turn. Watermark advances on live mail.
                if (typeof id === 'number') {
                  if (!mailWatermark.has(agentName)) {
                    if (!watermarkPending.has(agentName)) {
                      watermarkPending.add(agentName);
                      void initMailWatermark(agentName);
                    }
                    continue;
                  }
                  const wm = mailWatermark.get(agentName)!;
                  if (id <= wm) {
                    console.log(`[AcpSse] suppressed historical mail for ${agentName} id=${id} (<= watermark ${wm})`);
                    continue;
                  }
                  mailWatermark.set(agentName, id);
                }

                // Skip replayed/duplicate deliveries of the same message.
                // Id-less events dedupe on a content key so a later id'd
                // catch-up of the same mail doesn't double-notify (WO 11491).
                if (!markMailEventSeen(agentName, mailDedupeKey(id, from, subject))) {
                  console.log(`[AcpSse] Duplicate mail event for ${agentName} id=${id}; skipping`);
                  continue;
                }

                console.log(`[AcpSse] Mail for ${agentName}: ${from} — ${subject} (id=${id})`);

                const projectId = useProjectStore.getState().activeProject?.id;
                // Gate on confirmation (WO 1560 R3 / AC5): no inbox GETs before
                // [Start], even if a mail push lands while the boot confirm
                // picker is still open. pickerHasStarted flips true on [Start].
                // routeMailNotice joins the gate: it fires a body GET that
                // stamps read_at cloud-side — a pre-Start side effect on a
                // project the user has not engaged.
                if (useProjectStore.getState().pickerHasStarted) {
                  void routeMailNotice(agentName, from, subject, id);
                  useMailStore.getState().fetchInbox(agentName, projectId);
                }
              } catch (err) {
                console.error('[AcpSse] Failed to parse mail event:', err);
              }
            }

            // Phase 3: Party engine updates
            if (eventType === 'party-update' && data) {
              try {
                usePartyStore.getState().updateFromSse(JSON.parse(data));
              } catch (err) {
                console.error('[AcpSse] Failed to parse party event:', err);
              }
            }

            // Phase 3: Autonomy updates
            if (eventType === 'autonomy-update' && data) {
              try {
                useAutonomyStore.getState().updateFromSse(JSON.parse(data));
              } catch (err) {
                console.error('[AcpSse] Failed to parse autonomy event:', err);
              }
            }

            // Phase 4: Kanban updates
            if (eventType === 'kanban-update' && data) {
              try {
                useKanbanStore.getState().updateFromSse(JSON.parse(data));
              } catch (err) {
                console.error('[AcpSse] Failed to parse kanban event:', err);
              }
            }

            // Phase 4: Chat messages
            if (eventType === 'chat-message' && data) {
              try {
                useChatStore.getState().updateFromSse(JSON.parse(data));
              } catch (err) {
                console.error('[AcpSse] Failed to parse chat event:', err);
              }
            }

            // Contractor events
            if (eventType === 'contractor-hired' && data) {
              try {
                useContractorStore.getState().handleContractorHired(JSON.parse(data));
              } catch (err) {
                console.error('[AcpSse] Failed to parse contractor-hired event:', err);
              }
            }

            if (eventType === 'contractor-completed' && data) {
              try {
                useContractorStore.getState().handleContractorCompleted(JSON.parse(data));
              } catch (err) {
                console.error('[AcpSse] Failed to parse contractor-completed event:', err);
              }
            }

            if (eventType === 'contractor-expired' && data) {
              try {
                useContractorStore.getState().handleContractorExpired(JSON.parse(data));
              } catch (err) {
                console.error('[AcpSse] Failed to parse contractor-expired event:', err);
              }
            }

            if (eventType === 'contractor-cancelled' && data) {
              try {
                useContractorStore.getState().handleContractorCancelled(JSON.parse(data));
              } catch (err) {
                console.error('[AcpSse] Failed to parse contractor-cancelled event:', err);
              }
            }

            if (eventType === 'contractor-queued' && data) {
              try {
                useContractorStore.getState().handleContractorQueued(JSON.parse(data));
              } catch (err) {
                console.error('[AcpSse] Failed to parse contractor-queued event:', err);
              }
            }

            if (eventType === 'contractor-mailbox-assigned' && data) {
              try {
                useContractorStore.getState().handleContractorMailboxAssigned(JSON.parse(data));
              } catch (err) {
                console.error('[AcpSse] Failed to parse contractor-mailbox-assigned event:', err);
              }
            }

            if (eventType === 'contractor-promoted' && data) {
              try {
                useContractorStore.getState().handleContractorPromoted(JSON.parse(data));
              } catch (err) {
                console.error('[AcpSse] Failed to parse contractor-promoted event:', err);
              }
            }

            if (eventType === 'session-started' && data) {
              try {
                useContractorStore.getState().handleSessionStarted(JSON.parse(data));
              } catch (err) {
                console.error('[AcpSse] Failed to parse session-started event:', err);
              }
            }

            if (eventType === 'session-output' && data) {
              try {
                useContractorStore.getState().handleSessionOutput(JSON.parse(data));
              } catch (err) {
                console.error('[AcpSse] Failed to parse session-output event:', err);
              }
            }

            if (eventType === 'session-exited' && data) {
              try {
                useContractorStore.getState().handleSessionExited(JSON.parse(data));
              } catch (err) {
                console.error('[AcpSse] Failed to parse session-exited event:', err);
              }
            }

            if (eventType === 'project-switched') {
              // Startup-project is LAUNCH-ONCE (P0, BAPert 1065). A remote device
              // setting the startup project emits this event; it changes the NEXT
              // launch's project and must NEVER reload the running session. We
              // deliberately do NOT call handleProjectSwitched here — the session
              // stays pinned to its launch-time project until shutdown. Logged so
              // the cross-device re-test can confirm the event arrives and is ignored.
              console.log('[AcpSse] project-switched ignored — remote startup-project change applies at next launch, not this running session.');
            }

            // Team Check-in (Standup W3) — live report / round updates (DotNetPert W2 relay).
            if (eventType === 'standup_report' && data) {
              try {
                useCheckinStore.getState().handleReportSse(JSON.parse(data));
              } catch (err) {
                console.error('[AcpSse] Failed to parse standup_report event:', err);
              }
            }

            if (eventType === 'standup_round' && data) {
              try {
                useCheckinStore.getState().handleRoundSse(JSON.parse(data));
              } catch (err) {
                console.error('[AcpSse] Failed to parse standup_round event:', err);
              }
            }

            // Unattended mode events
            if ((eventType === 'unattended-started' || eventType === 'unattended-paused') && data) {
              try {
                useAutonomyStore.getState().updateFromSse(JSON.parse(data));
              } catch (err) {
                console.error(`[AcpSse] Failed to parse ${eventType} event:`, err);
              }
            }
          }
        }

        // Stream ended — reconnect
        if (!disposed) {
          // Stale connection (the watchdog already replaced us): it owns the
          // reconnect; do not schedule a second one.
          if (abortRef.current !== myCtrl) return;
          console.log('[AcpSse] Stream ended, reconnecting...');
          setConn('reconnecting');
          setTimeout(() => { if (!disposed && abortRef.current === myCtrl) connect(); }, 2000);
        }
      } catch (err) {
        if (disposed) return;
        // Stale connection (the ping watchdog already aborted and replaced
        // us): bail WITHOUT touching the live controller or retry state —
        // otherwise we'd abort the NEW connection and stack a duplicate
        // stream (WO 11517 P1).
        if (abortRef.current !== myCtrl) return;
        retryCount++;
        setConn('reconnecting');
        myCtrl.abort(); // we own this one; the connection is already dead
        const delay = Math.min(2000 * Math.pow(2, retryCount - 1), 30000) + Math.random() * 1000;
        console.error(`[AcpSse] Error (retry ${retryCount}, next in ${Math.round(delay)}ms):`, err);
        setTimeout(() => { if (!disposed && abortRef.current === myCtrl) connect(); }, delay);
      }
    }

    // WO 11473: inbox GETs are gated on the boot picker ([Start]); when it
    // flips, run the catch-up so the sidebar reflects reload-window mail
    // promptly instead of waiting for the next SSE reconnect. (The notice
    // synthesis that also ran here was removed — see the Connected site.)
    const unsubPicker = useProjectStore.subscribe((state, prev) => {
      if (state.pickerHasStarted && !prev.pickerHasStarted) {
        void catchUp().catch(() => {});
      }
    });

    connect();

    return () => {
      console.log('[AcpSse] Disconnecting');
      disposed = true;
      connectingRef.current = false;
      clearInterval(pingWatchdog);
      unsubPicker();
      abortRef.current?.abort();
      abortRef.current = null;
      setConn('disconnected');
    };
  }, [backendAvailable, agentNamesKey]);

  return {
    connectionState: connectionStateRef,
    lastPing: lastPingRef,
  };
}
