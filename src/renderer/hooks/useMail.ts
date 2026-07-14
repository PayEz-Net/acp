import { useEffect, useRef, useCallback, useMemo } from 'react';
import { useMailStore, markMessageRead, markAllMessagesRead } from '../stores/mailStore';
import { useProjectStore } from '../stores/projectStore';
import { useIsAuthenticated } from '../stores/authStore';
import { MailMessage, PanelAction } from '@shared/types';

interface UseMailOptions {
  agents: string[];
  pollInterval?: number;
  enabled?: boolean;
}

export function useMail({ agents, pollInterval = 30000, enabled = true }: UseMailOptions) {
  const {
    mailboxes,
    selectedMessage,
    selectedMessageActions,
    selectedMessageSuggested,
    isComposing,
    replyTo,
    fetchAllInboxes,
    fetchMessage,
    selectMessage,
    setComposing,
    markAsRead,
    setMailbox,
    sendMessage,
    executeAction,
    showUnreadOnly,
    toggleUnreadFilter,
  } = useMailStore();
  const activeProjectId = useProjectStore((s) => s.activeProject)?.id;

  const pollRef = useRef<NodeJS.Timeout | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const lastFetchedKeyRef = useRef<string>('');
  const agentsRef = useRef(agents);
  const activeProjectIdRef = useRef(activeProjectId);
  const pollIntervalRef = useRef(pollInterval);
  const fetchAllInboxesRef = useRef(fetchAllInboxes);

  agentsRef.current = agents;
  activeProjectIdRef.current = activeProjectId;
  pollIntervalRef.current = pollInterval;
  fetchAllInboxesRef.current = fetchAllInboxes;

  const isAuthenticated = useIsAuthenticated();
  const effectiveEnabled = enabled && isAuthenticated;

  // Stable fetch key so the effect only re-runs when the agent roster or project
  // actually changes, not when a new array reference is passed.
  const agentsKey = useMemo(() => agents.slice().sort().join(','), [agents]);
  const fetchKey = useMemo(() => `${agentsKey}|${activeProjectId ?? 'none'}`, [agentsKey, activeProjectId]);

  // Initial fetch and polling
  useEffect(() => {
    const currentAgents = agentsRef.current;
    const currentProjectId = activeProjectIdRef.current;
    const currentInterval = pollIntervalRef.current;
    const currentFetchAllInboxes = fetchAllInboxesRef.current;

    console.log(`[useMail] Effect — effectiveEnabled: ${effectiveEnabled} (enabled: ${enabled}, isAuthenticated: ${isAuthenticated}), agents: [${currentAgents.join(', ')}]`);
    if (!effectiveEnabled || currentAgents.length === 0) return;

    // Guard against duplicate initial fetches when dependencies settle or the
    // component re-renders with the same agent roster + project.
    if (fetchKey === lastFetchedKeyRef.current) {
      console.log(`[useMail] Already fetched for ${fetchKey}; skipping duplicate initial fetch`);
      return;
    }
    lastFetchedKeyRef.current = fetchKey;

    // Abort any previous in-flight request before starting a new cycle.
    abortRef.current?.abort();
    const abortController = new AbortController();
    abortRef.current = abortController;

    // Initial fetch
    console.log(`[useMail] Starting initial fetch + ${currentInterval}ms polling for ${currentAgents.length} agents, project=${currentProjectId ?? 'none'}`);
    currentFetchAllInboxes(currentAgents, currentProjectId, abortController.signal);

    // Set up polling
    pollRef.current = setInterval(() => {
      currentFetchAllInboxes(currentAgents, currentProjectId, abortController.signal);
    }, currentInterval);

    return () => {
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
      abortController.abort();
      if (abortRef.current === abortController) {
        abortRef.current = null;
      }
    };
  }, [fetchKey, effectiveEnabled]);

  // Window-focus catch-up (#225): when the app regains focus, pull a fresh
  // fetch so the sidebar is current the moment the user looks at it — covers
  // the gap if SignalR push died and the next 30s poll tick hasn't fired yet.
  // Event-driven, NOT a second poll. Gated on the same effectiveEnabled (auth)
  // so it can't hammer a terminal-dead session.
  useEffect(() => {
    if (!effectiveEnabled || agentsRef.current.length === 0) return;
    const onFocus = () => fetchAllInboxesRef.current(agentsRef.current, activeProjectIdRef.current);
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [effectiveEnabled]);

  // Handle message selection - fetch full message with actions
  const handleSelectMessage = useCallback(async (message: MailMessage | null) => {
    if (message) {
      // Fetch full message with ActionPanel response
      await fetchMessage(message.message_id);

      // Mark as read if unread
      if (!message.is_read) {
        const success = await markMessageRead(message.message_id);
        if (success) {
          markAsRead(message.message_id);
        }
      }
    } else {
      selectMessage(null);
    }
  }, [fetchMessage, selectMessage, markAsRead]);

  // Handle executing an action from the ActionPanel
  const handleExecuteAction = useCallback(async (action: PanelAction) => {
    await executeAction(action);
  }, [executeAction]);

  // Refresh manually
  const refresh = useCallback(() => {
    fetchAllInboxesRef.current(agentsRef.current, activeProjectIdRef.current);
  }, []);

  // Scope mailboxes to active project (QAPert L2 landmine fix)
  const scopedMailboxes = useMemo(() => {
    if (activeProjectId === undefined) return mailboxes;
    const prefix = `${activeProjectId}:`;
    const result: typeof mailboxes = {};
    for (const [key, mailbox] of Object.entries(mailboxes)) {
      if (key.startsWith(prefix)) {
        result[key.slice(prefix.length)] = mailbox;
      }
    }
    return result;
  }, [mailboxes, activeProjectId]);

  // Total unread across all agents (scoped to current project).
  // Use the server-provided unreadCount so the button stays enabled when the
  // message list is paginated/filtered and does not contain every unread message.
  const totalUnread = Object.values(scopedMailboxes).reduce(
    (sum, mb) => sum + (mb?.unreadCount || 0),
    0
  );

  // Get unread count for specific agent
  const getUnreadCount = useCallback((agent: string) => {
    return scopedMailboxes[agent]?.unreadCount || 0;
  }, [scopedMailboxes]);

  // Get messages for specific agent
  const getMessages = useCallback((agent: string) => {
    return scopedMailboxes[agent]?.messages || [];
  }, [scopedMailboxes]);

  // Check if loading for specific agent
  const isLoading = useCallback((agent: string) => {
    return scopedMailboxes[agent]?.loading || false;
  }, [scopedMailboxes]);

  // Mark ALL messages read across the current project's agents (BAPert 1310).
  // The cloud endpoint is per agentName + project_id; acp-api scopes to the
  // current project the same way fetchInbox does. Send for every agent and let
  // the server decide what to mark — the local unread count is not authoritative.
  const markAllRead = useCallback(async (): Promise<{ ok: boolean; failed: string[] }> => {
    const targets = agentsRef.current;
    const projectId = activeProjectIdRef.current;
    if (targets.length === 0) return { ok: true, failed: [] };
    const results = await Promise.all(
      targets.map(async (a) => ({ agent: a, res: await markAllMessagesRead(a) })),
    );
    const failed = results.filter((r) => !r.res.success).map((r) => r.agent);

    // Optimistically clear the unread state for successful agents so the UI
    // reacts immediately while the authoritative fetch catches up.
    for (const { agent, res } of results) {
      if (!res.success) continue;
      const key = projectId !== undefined ? `${projectId}:${agent}` : agent;
      const existing = useMailStore.getState().mailboxes[key];
      if (existing) {
        setMailbox(agent, {
          unreadCount: 0,
          messages: existing.messages.map((m) => ({ ...m, is_read: true })),
        }, projectId);
      }
    }

    fetchAllInboxesRef.current(agentsRef.current, projectId);
    return { ok: failed.length === 0, failed };
  }, []);

  return {
    // State
    mailboxes,
    selectedMessage,
    selectedMessageActions,
    selectedMessageSuggested,
    isComposing,
    replyTo,
    totalUnread,
    showUnreadOnly,

    // Per-agent helpers
    getUnreadCount,
    getMessages,
    isLoading,

    // Actions
    selectMessage: handleSelectMessage,
    setComposing,
    sendMessage,
    executeAction: handleExecuteAction,
    refresh,
    markAllRead,
    toggleUnreadFilter,
  };
}
