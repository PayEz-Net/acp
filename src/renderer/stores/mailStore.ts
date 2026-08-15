import { create } from 'zustand';
import { MailMessage, AgentMailbox, PanelAction } from '@shared/types';
import { IDP_CLIENT_APP, IDP_CLIENT_APP_HEADER } from '@shared/idp-config';
import { useAppStore } from './appStore';
import { useProjectStore } from './projectStore';
import { useAuthStore, AuthFlowState } from './authStore';
import { buildUrl, getCachedLocalSecret, clearSecretCache } from './api-helpers';

/**
 * Live mail-push (SSE) connection state, surfaced from useAcpSse so the UI can
 * show a reconnecting/offline indicator instead of a silent freeze (#225).
 * Mirrors useAcpSse's SseConnectionState.
 */
export type PushConnectionState = 'connected' | 'reconnecting' | 'disconnected';

const USE_MOCK_DATA = false;

// -----------------------------------------------------------------------------
// Mail API routing: acp-api (Bearer) only — no HMAC in renderer (Option C)
// When backend is unavailable, mail is disabled entirely.
// -----------------------------------------------------------------------------



/** Check if acp-api backend is available */
function isBackendAvailable(): boolean {
  return useAppStore.getState().backendAvailable;
}

function isAuthenticated(): boolean {
  return useAuthStore.getState().authFlowState === AuthFlowState.AUTHENTICATED;
}

/** Resolve projectId fallback from store when caller omitted it */
function resolveProjectId(projectId?: number): number | undefined {
  return projectId ?? useProjectStore.getState().activeProject?.id;
}

/** Return true if an error is an abort/signal cancellation (benign noise). */
function isAbortError(err: unknown): boolean {
  if (err instanceof DOMException && err.name === 'AbortError') return true;
  if (err instanceof Error && err.name === 'AbortError') return true;
  return false;
}

/** Extract bare agent name from a composite mailbox key */
function extractAgentFromKey(key: string): string {
  const idx = key.indexOf(':');
  return idx >= 0 ? key.slice(idx + 1) : key;
}

// Agent mail aliases: map a UI-facing agent name to the name registered in the
// cloud agentmail registry. Previously used to route NextPert mail through its
// spawned instance Nextpert-Scout during the agent-identity overhaul; the
// registry now resolves NextPert directly, so no aliases are currently needed.
const AGENT_MAIL_ALIASES: Record<string, string> = {};

export function resolveMailAlias(agent: string): string {
  return AGENT_MAIL_ALIASES[agent] || agent;
}

/** Reverse map an aliased API agent name back to the UI-facing agent name. */
export function unresolveMailAlias(alias: string): string {
  for (const [name, mapped] of Object.entries(AGENT_MAIL_ALIASES)) {
    if (mapped === alias) return name;
  }
  return alias;
}

// ---------------------------------------------------------------------------
// P0 mail comms-lockup guards (task #11). Root: fetchAllInboxes per-agent
// fan-out, fired by 5 stacking triggers (poll/focus/mount/SSE/post-read) +
// SSE bursts -> repeated N-request storms -> acp-api 429 -> all inboxes fail.
// Fix: fetchAllInboxes now calls DnP's ONE aggregated endpoint (3b6878f); these
// guards coalesce the triggers, cap per-agent dup fetches, and back off on 429
// so a 429 can never retry-storm.
// ---------------------------------------------------------------------------
let _allInFlight: Promise<void> | null = null;   // coalesce concurrent fetchAllInboxes
let _allLastDone = 0;                             // cooldown anchor (collapse rapid re-fire)
const ALL_COOLDOWN_MS = 600;
const _inboxInFlight = new Set<string>();         // per-agent in-flight guard (SSE per-event dup)
let _rateLimitedUntil = 0;                        // global 429 backoff window
const RATE_LIMIT_BACKOFF_MS = 8000;

/**
 * Make authenticated request to the mail API via acp-api.
 * Throws if backend is unavailable (Option C: mail disabled without backend).
 * Throws if not authenticated (WO-2B: don't talk to a terminal-dead sidecar).
 * On 401, clears cached secret and retries once with fresh secret (Phase 5: secret rotation).
 */
async function mailRequest(endpoint: string, options: { method?: string; body?: unknown; agentName?: string; signal?: AbortSignal } = {}) {
  if (!isBackendAvailable()) {
    throw new Error('Mail unavailable: backend not connected');
  }
  if (!isAuthenticated()) {
    throw new Error('Mail unavailable: not authenticated');
  }

  const { method = 'GET', body, agentName } = options;
  const url = buildUrl('/v1/mail', endpoint);

  async function doFetch(): Promise<Response> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      [IDP_CLIENT_APP_HEADER]: IDP_CLIENT_APP,
    };
    const secret = await getCachedLocalSecret();
    if (secret) {
      headers['Authorization'] = `Bearer ${secret}`;
    }
    // Belt-and-suspenders: X-ACP-Agent as fallback auth if Bearer is
    // missing/stale. localAuth middleware accepts either.
    if (agentName) {
      headers['X-ACP-Agent'] = agentName;
    }
    return fetch(url, {
      method,
      headers,
      ...(body ? { body: JSON.stringify(body) } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    });
  }

  console.log(`[Mail] → acp-api: ${method} ${endpoint}${agentName ? ` (agent: ${agentName})` : ''}`);
  let res = await doFetch();

  // Secret rotation: on 401, clear cache and retry once with fresh secret
  if (res.status === 401) {
    console.log('[Mail] 401 — rotating secret and retrying');
    clearSecretCache();
    res = await doFetch();
  }

  return res;
}

// Mock data for demo
const MOCK_MESSAGES: Record<string, MailMessage[]> = {
  BAPert: [
    { message_id: 1, from_agent: 'NextPert', to_agent: 'BAPert', subject: 'COMPLETE: Phase 3 Kanban', body: 'Kanban sidebar is done with drag-and-drop.', is_read: false, created_at: new Date().toISOString() },
    { message_id: 2, from_agent: 'DotNetPert', to_agent: 'BAPert', subject: 'BLOCKED: Need DB schema', body: 'Waiting on vibe_agents schema creation.', is_read: true, created_at: new Date(Date.now() - 3600000).toISOString() },
  ],
  NextPert: [
    { message_id: 3, from_agent: 'BAPert', to_agent: 'NextPert', subject: 'TASK: Phase 4 Polish', body: 'Add keyboard shortcuts and window state persistence.', is_read: false, created_at: new Date().toISOString() },
    { message_id: 4, from_agent: 'QAPert', to_agent: 'NextPert', subject: 'APPROVED: Code review passed', body: 'Kanban code looks good. Ship it!', is_read: false, created_at: new Date(Date.now() - 1800000).toISOString() },
  ],
  DotNetPert: [
    { message_id: 5, from_agent: 'BAPert', to_agent: 'DotNetPert', subject: 'TASK: Vibe Agents Backend', body: 'Implement the /features/agents endpoints.', is_read: true, created_at: new Date(Date.now() - 7200000).toISOString() },
  ],
  QAPert: [
    { message_id: 6, from_agent: 'BAPert', to_agent: 'QAPert', subject: 'REVIEW: Harness Phase 3', body: 'Please review the Kanban implementation.', is_read: false, created_at: new Date(Date.now() - 900000).toISOString() },
  ],
};

// Extended mailbox state with ActionPanel fields
interface ExtendedMailbox extends AgentMailbox {
  actions?: PanelAction[];
  suggested?: string;
}

interface MailStore {
  // State per agent
  mailboxes: Record<string, ExtendedMailbox>;
  selectedMessage: MailMessage | null;
  selectedMessageActions?: PanelAction[];
  selectedMessageSuggested?: string;
  isComposing: boolean;
  replyTo: MailMessage | null;
  showUnreadOnly: boolean;
  // Live SSE push connection state (from useAcpSse), surfaced to the UI so a
  // dead/reconnecting push is VISIBLE instead of a silent freeze (#225).
  pushConnectionState: PushConnectionState;

  // Actions
  setMailbox: (agent: string, mailbox: Partial<ExtendedMailbox>, projectId?: number) => void;
  setPushConnectionState: (state: PushConnectionState) => void;
  selectMessage: (message: MailMessage | null) => void;
  setComposing: (isComposing: boolean, replyTo?: MailMessage | null) => void;
  markAsRead: (messageId: number) => void;
  toggleUnreadFilter: () => void;

  // API actions
  fetchInbox: (agent: string, projectId?: number) => Promise<void>;
  fetchAllInboxes: (agents: string[], projectId?: number, signal?: AbortSignal) => Promise<void>;
  fetchMessage: (messageId: number) => Promise<void>;
  sendMessage: (from: string, to: string, subject: string, body: string) => Promise<boolean>;
  executeAction: (action: PanelAction) => Promise<void>;
}

export const useMailStore = create<MailStore>((set, get) => ({
  mailboxes: {},
  selectedMessage: null,
  selectedMessageActions: undefined,
  selectedMessageSuggested: undefined,
  isComposing: false,
  replyTo: null,
  showUnreadOnly: false,
  pushConnectionState: 'disconnected',

  setPushConnectionState: (state) => set({ pushConnectionState: state }),

  setMailbox: (agent, update, projectId) => set((state) => {
    const pid = resolveProjectId(projectId);
    const key = pid !== undefined ? `${pid}:${agent}` : agent;
    const existing = state.mailboxes[key] || {
      agent,
      messages: [],
      unreadCount: 0,
      loading: false,
    };
    return {
      mailboxes: {
        ...state.mailboxes,
        [key]: { ...existing, ...update },
      },
    };
  }),

  selectMessage: (message) => set({
    selectedMessage: message,
    selectedMessageActions: undefined,
    selectedMessageSuggested: undefined,
    isComposing: false,
  }),

  setComposing: (isComposing, replyTo = null) => set({
    isComposing,
    replyTo,
    selectedMessage: null,
  }),

  toggleUnreadFilter: () => {
    const newValue = !get().showUnreadOnly;
    set({ showUnreadOnly: newValue });
    // Re-fetch all inboxes with new filter
    // Extract bare agent names from composite keys (QAPert composite-key leak fix)
    const agents = Object.keys(get().mailboxes).map(extractAgentFromKey);
    const uniqueAgents = [...new Set(agents)];
    if (uniqueAgents.length > 0) {
      const { fetchInbox } = get();
      uniqueAgents.forEach(agent => fetchInbox(agent));
    }
  },

  markAsRead: (messageId) => set((state) => {
    const newMailboxes = { ...state.mailboxes };
    for (const agent of Object.keys(newMailboxes)) {
      newMailboxes[agent] = {
        ...newMailboxes[agent],
        messages: newMailboxes[agent].messages.map((m) =>
          m.message_id === messageId ? { ...m, is_read: true } : m
        ),
        unreadCount: newMailboxes[agent].messages.filter(
          (m) => !m.is_read && m.message_id !== messageId
        ).length,
      };
    }
    return { mailboxes: newMailboxes };
  }),

  fetchInbox: async (agent, projectId) => {
    const { setMailbox } = get();
    const pid = resolveProjectId(projectId);
    // P0 storm guard (real path): skip during 429 backoff + collapse duplicate
    // concurrent fetches for the same agent (the SSE per-event amplifier).
    if (!USE_MOCK_DATA) {
      if (Date.now() < _rateLimitedUntil) return;
      if (_inboxInFlight.has(agent)) return;
      _inboxInFlight.add(agent);
    }
    console.log(`[Mail] fetchInbox(${agent}) — backendAvailable: ${isBackendAvailable()}, project=${pid ?? 'none'}`);
    setMailbox(agent, { loading: true, error: undefined }, pid);

    // Use mock data for demo
    if (USE_MOCK_DATA) {
      await new Promise((r) => setTimeout(r, 300)); // Simulate network delay
      const messages = MOCK_MESSAGES[agent] || [];
      setMailbox(agent, {
        messages,
        unreadCount: messages.filter((m) => !m.is_read).length,
        loading: false,
      });
      return;
    }

    try {
      const showUnread = get().showUnreadOnly;

      if (showUnread) {
        // Cloud API ignores ?unread=true, so we paginate client-side to find unreads.
        // Fetch pages until we've collected all unread messages or exhausted pages.
        const unreadMessages: MailMessage[] = [];
        let page = 1;
        let totalPages = 1;
        let serverUnreadCount = 0;

        while (page <= totalPages && page <= 20) { // safety cap at 20 pages
          const qs = `?page=${page}&page_size=50`;
          const apiAgent = resolveMailAlias(agent);
          const res = await mailRequest(`/inbox/${encodeURIComponent(apiAgent)}${qs}`, { agentName: apiAgent });
          if (res.status === 429) { _rateLimitedUntil = Date.now() + RATE_LIMIT_BACKOFF_MS; throw new Error('rate limited (429)'); }
          if (!res.ok) throw new Error(`Failed to fetch: ${res.status}`);
          const response = await res.json();
          if (!response.success) throw new Error(response.error || 'Request failed');

          totalPages = response.pagination?.total_pages || 1;
          if (page === 1) {
            serverUnreadCount = response.data?.unread_count ?? 0;
          }

          const rawMessages = response.data?.messages || [];
          for (const m of rawMessages) {
            if (!m.read_at) {
              unreadMessages.push({
                ...m,
                to_agent: (m.to_agent as string) || (Array.isArray(m.to) ? (m.to as string[]).join(', ') : m.to as string) || agent,
                is_read: false,
              });
            }
          }

          // Stop early if we've found all unreads
          if (serverUnreadCount > 0 && unreadMessages.length >= serverUnreadCount) break;
          page++;
        }

        setMailbox(agent, {
          messages: unreadMessages,
          unreadCount: serverUnreadCount || unreadMessages.length,
          loading: false,
        }, pid);
      } else {
        // Normal fetch: single page
        const apiAgent = resolveMailAlias(agent);
        const res = await mailRequest(`/inbox/${encodeURIComponent(apiAgent)}`, { agentName: apiAgent });
        if (res.status === 429) { _rateLimitedUntil = Date.now() + RATE_LIMIT_BACKOFF_MS; throw new Error('rate limited (429)'); }
        if (!res.ok) throw new Error(`Failed to fetch: ${res.status}`);
        const response = await res.json();
        if (!response.success) throw new Error(response.error || 'Request failed');

        const rawMessages = response.data?.messages || [];
        const allMessages: MailMessage[] = rawMessages.map((m: Record<string, unknown>) => ({
          ...m,
          to_agent: (m.to_agent as string) || (Array.isArray(m.to) ? (m.to as string[]).join(', ') : m.to as string) || agent,
          is_read: !!m.read_at,
        }));

        setMailbox(agent, {
          messages: allMessages,
          unreadCount: response.data?.unread_count ?? allMessages.filter((m) => !m.is_read).length,
          loading: false,
          actions: response.actions,
          suggested: response.suggested,
        }, pid);
      }
    } catch (err) {
      if (isAbortError(err)) {
        // Caller aborted (e.g., React StrictMode cleanup) — not a real failure.
        setMailbox(agent, { loading: false }, pid);
        return;
      }
      console.error(`[Mail] Failed to fetch inbox for ${agent}:`, err);
      setMailbox(agent, {
        loading: false,
        error: err instanceof Error ? err.message : 'Failed to fetch',
      });
    } finally {
      _inboxInFlight.delete(agent);
    }
  },

  fetchAllInboxes: async (agents, projectId, signal) => {
    // P0 fix (task #11): ONE aggregated request (DnP acp-api 3b6878f), NOT a
    // per-agent fan-out — server-side fan-out kills the client burst that 429s.
    // Coalesce the 5 stacking triggers (poll/focus/mount/SSE/post-read) into one
    // call via the in-flight guard + cooldown; back off on 429 (no retry-storm).
    if (_allInFlight) return _allInFlight;                              // concurrent → reuse the running fan-out
    if (Date.now() - _allLastDone < ALL_COOLDOWN_MS) return;           // rapid re-fire → cooldown
    if (Date.now() < _rateLimitedUntil) return;                        // in 429 backoff → skip
    if (!agents.length) return;

    _allInFlight = (async () => {
      const { setMailbox, fetchInbox } = get();
      const pid = resolveProjectId(projectId);

      // Mock / no-backend: keep the legacy per-agent path (no storm there).
      if (USE_MOCK_DATA || !isBackendAvailable()) {
        await Promise.all(agents.map((agent) => fetchInbox(agent, pid)));
        return;
      }

      try {
        const aliasToAgent = new Map(agents.map((a) => [resolveMailAlias(a), a]));
        const apiAgents = agents.map((a) => resolveMailAlias(a));
        const qs = `?agents=${encodeURIComponent(apiAgents.join(','))}`;
        const res = await mailRequest(`/inboxes${qs}`, { signal });
        if (res.status === 429) { _rateLimitedUntil = Date.now() + RATE_LIMIT_BACKOFF_MS; return; }
        if (!res.ok) throw new Error(`Failed to fetch inboxes: ${res.status}`);
        const response = await res.json();
        if (!response.success) throw new Error(response.error || 'Request failed');

        const inboxes: Record<string, { messages?: Record<string, unknown>[]; unread_count?: number; error?: { code?: string; message?: string } }> =
          response.data?.inboxes || {};
        const showUnread = get().showUnreadOnly;

        // Per-agent isolation is enforced server-side (a failing agent → error+empty,
        // others intact, QA 6751 axis-2). Map each into the store exactly as fetchInbox does.
        // Aliased agents are requested by their registered name, so map response keys back
        // to the UI-facing agent name before storing.
        for (const apiAgent of Object.keys(inboxes)) {
          const agent = aliasToAgent.get(apiAgent) ?? unresolveMailAlias(apiAgent);
          const box = inboxes[apiAgent];
          if (!box) { setMailbox(agent, { loading: false }, pid); continue; }
          if (box.error) { setMailbox(agent, { loading: false, error: box.error.message || 'Failed to fetch' }, pid); continue; }
          const raw = box.messages || [];
          let messages: MailMessage[] = raw.map((m) => ({
            ...m,
            to_agent: (m.to_agent as string) || (Array.isArray(m.to) ? (m.to as string[]).join(', ') : m.to as string) || agent,
            is_read: !!m.read_at,
          })) as MailMessage[];
          if (showUnread) messages = messages.filter((m) => !m.is_read);
          setMailbox(agent, {
            messages,
            unreadCount: box.unread_count ?? messages.filter((m) => !m.is_read).length,
            loading: false,
          }, pid);
        }
      } catch (err) {
        if (isAbortError(err)) {
          // Caller aborted (e.g., React StrictMode cleanup) — not a real failure.
          for (const agent of agents) setMailbox(agent, { loading: false }, pid);
          return;
        }
        console.error('[Mail] fetchAllInboxes (aggregated) failed:', err);
        // No retry-storm: clear loading, leave existing data; the next non-cooldown trigger retries.
        for (const agent of agents) setMailbox(agent, { loading: false }, pid);
      }
    })().finally(() => { _allInFlight = null; _allLastDone = Date.now(); });

    return _allInFlight;
  },

  fetchMessage: async (messageId) => {
    try {
      const res = await mailRequest(`/messages/${messageId}`);

      if (!res.ok) {
        throw new Error(`Failed to fetch message: ${res.status}`);
      }

      const response = await res.json();

      if (!response.success) {
        throw new Error(response.error || 'Request failed');
      }

      // ActionPanel response: { success, data: { ...message }, actions, suggested, context }
      const raw = response.data;
      const message: MailMessage = {
        ...raw,
        to_agent: raw.to_agent || (Array.isArray(raw.to) ? raw.to.join(', ') : raw.to) || '',
        is_read: raw.is_read ?? !!raw.read_at,
      };

      set({
        selectedMessage: message,
        selectedMessageActions: response.actions,
        selectedMessageSuggested: response.suggested,
        isComposing: false,
      });
    } catch (err) {
      console.error(`[Mail] Failed to fetch message ${messageId}:`, err);
    }
  },

  sendMessage: async (from, to, subject, body) => {
    try {
      const apiTo = resolveMailAlias(to);
      const res = await mailRequest('/send', {
        method: 'POST',
        body: {
          from_agent: from,
          to: [apiTo],
          subject,
          body,
        },
        agentName: from,
      });

      if (!res.ok) {
        throw new Error(`Failed to send: ${res.status}`);
      }

      const response = await res.json();

      if (!response.success) {
        throw new Error(response.error || 'Send failed');
      }

      // Refresh recipient's inbox (scoped to active project)
      const { fetchInbox } = get();
      await fetchInbox(to, resolveProjectId());

      return true;
    } catch (err) {
      console.error('[Mail] Failed to send message:', err);
      return false;
    }
  },

  executeAction: async (action) => {
    const { fetchInbox, fetchMessage, setComposing, selectedMessage } = get();

    console.log('[Mail] Executing action:', action.action, action.params);

    switch (action.action) {
      case 'read':
        if (action.params?.id) {
          await fetchMessage(action.params.id as number);
        }
        break;

      case 'reply':
        if (selectedMessage) {
          setComposing(true, selectedMessage);
        }
        break;

      case 'compose':
        setComposing(true, null);
        break;

      case 'archive':
      case 'mark_read':
        if (action.params?.id) {
          // action.params.id is a MESSAGE id; the route needs the INBOX id.
          // Resolve it from the selected message rather than guessing — a wrong
          // id here silently marks somebody else's mail read (see
          // markMessageRead). If it cannot be resolved, do nothing and say so:
          // a skipped read is recoverable, a wrong-row write is not.
          const targetMessageId = action.params.id as number;
          const inboxId =
            selectedMessage && selectedMessage.message_id === targetMessageId
              ? selectedMessage.inbox_id
              : undefined;
          if (inboxId == null) {
            console.warn(
              `[Mail] mark_read skipped: no inbox_id for message ${targetMessageId} ` +
              `(selected message is ${selectedMessage?.message_id ?? 'none'})`,
            );
            break;
          }
          await markMessageRead(inboxId);
          // Refresh the inbox for the message recipient (scoped to active project)
          if (selectedMessage) {
            await fetchInbox(selectedMessage.to_agent, resolveProjectId());
          }
        }
        break;

      case 'check_inbox': {
        // P0: refresh via the guarded aggregated path, NOT a per-agent fan-out.
        const uniqueAgents = [...new Set(Object.keys(get().mailboxes).map(extractAgentFromKey))];
        await get().fetchAllInboxes(uniqueAgents, resolveProjectId());
        break;
      }

      default:
        console.warn(`[Mail] Unknown action: ${action.action}`);
    }
  },
}));

/**
 * Mark one message read on the server.
 *
 * TAKES THE **INBOX** ID, NOT THE MESSAGE ID. Every inbox entry carries both,
 * from two different sequences (message 27804 lives in inbox row 87106). The
 * route is `/inbox/{inbox_id}/read`, and handing it a message id does not fail
 * — it names a REAL BUT UNRELATED inbox row and marks that one read, returning
 * `200 {"success":true}` for the wrong mail. Measured 2026-08-14: POSTing
 * message id 27785 marked the row holding message 11523.
 *
 * The parameter is named `inboxId` on purpose. It was `messageId`, and both
 * call sites duly passed a message id.
 */
export async function markMessageRead(inboxId: number): Promise<boolean> {
  try {
    const res = await mailRequest(`/inbox/${inboxId}/read`, { method: 'POST' });
    if (!res.ok) {
      throw new Error(`Failed to mark as read: ${res.status}`);
    }

    const response = await res.json();
    return response.success;
  } catch (err) {
    console.error('[Mail] Failed to mark as read:', err);
    return false;
  }
}

// Mark all messages as read for an agent
export async function markAllMessagesRead(agent: string): Promise<{ success: boolean; marked?: number }> {
  try {
    const res = await mailRequest(`/inbox/${encodeURIComponent(agent)}/read-all`, { method: 'POST', agentName: agent });
    if (!res.ok) {
      throw new Error(`Failed to mark all as read: ${res.status}`);
    }

    const response = await res.json();
    return { success: response.success, marked: response.data?.marked };
  } catch (err) {
    console.error('[Mail] Failed to mark all as read:', err);
    return { success: false };
  }
}
