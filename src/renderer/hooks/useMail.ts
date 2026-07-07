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
    sendMessage,
    executeAction,
    showUnreadOnly,
    toggleUnreadFilter,
  } = useMailStore();
  const activeProjectId = useProjectStore((s) => s.activeProject)?.id;

  const pollRef = useRef<NodeJS.Timeout | null>(null);

  const isAuthenticated = useIsAuthenticated();
  const effectiveEnabled = enabled && isAuthenticated;

  // Initial fetch and polling
  useEffect(() => {
    console.log(`[useMail] Effect — effectiveEnabled: ${effectiveEnabled} (enabled: ${enabled}, isAuthenticated: ${isAuthenticated}), agents: [${agents.join(', ')}]`);
    if (!effectiveEnabled || agents.length === 0) return;

    // Initial fetch
    console.log(`[useMail] Starting initial fetch + ${pollInterval}ms polling for ${agents.length} agents, project=${activeProjectId ?? 'none'}`);
    fetchAllInboxes(agents, activeProjectId);

    // Set up polling
    pollRef.current = setInterval(() => {
      fetchAllInboxes(agents, activeProjectId);
    }, pollInterval);

    return () => {
      if (pollRef.current) {
        clearInterval(pollRef.current);
      }
    };
  }, [agents.join(','), pollInterval, effectiveEnabled, fetchAllInboxes]);

  // Window-focus catch-up (#225): when the app regains focus, pull a fresh
  // fetch so the sidebar is current the moment the user looks at it — covers
  // the gap if SignalR push died and the next 30s poll tick hasn't fired yet.
  // Event-driven, NOT a second poll. Gated on the same effectiveEnabled (auth)
  // so it can't hammer a terminal-dead session.
  useEffect(() => {
    if (!effectiveEnabled || agents.length === 0) return;
    const onFocus = () => fetchAllInboxes(agents, activeProjectId);
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [agents.join(','), effectiveEnabled, fetchAllInboxes, activeProjectId]);

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
    fetchAllInboxes(agents, activeProjectId);
  }, [agents, fetchAllInboxes, activeProjectId]);

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
  // Info-tier scout chatter does not interrupt workflow, so it is excluded from
  // the unread count surfaced on the mail icon.
  const totalUnread = Object.values(scopedMailboxes).reduce(
    (sum, mb) =>
      sum +
      (mb?.messages?.filter((m) => !m.is_read && m.importance !== 'info').length || 0),
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
  // current project the same way fetchInbox does. Only hit agents that have
  // unread, then refresh so the badges reflect unread->0. Returns which agents
  // (if any) failed so the caller can surface it instead of failing silently.
  const markAllRead = useCallback(async (): Promise<{ ok: boolean; failed: string[] }> => {
    const targets = agents.filter((a) => getUnreadCount(a) > 0);
    if (targets.length === 0) return { ok: true, failed: [] };
    const results = await Promise.all(
      targets.map(async (a) => ({ agent: a, res: await markAllMessagesRead(a) })),
    );
    const failed = results.filter((r) => !r.res.success).map((r) => r.agent);
    fetchAllInboxes(agents, activeProjectId);
    return { ok: failed.length === 0, failed };
  }, [agents, getUnreadCount, fetchAllInboxes, activeProjectId]);

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
