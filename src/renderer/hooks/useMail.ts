import { useEffect, useRef, useCallback } from 'react';
import { useMailStore, markMessageRead } from '../stores/mailStore';
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
  } = useMailStore();

  const pollRef = useRef<NodeJS.Timeout | null>(null);

  // Initial fetch and polling
  useEffect(() => {
    if (!enabled || agents.length === 0) return;

    // Initial fetch
    fetchAllInboxes(agents);

    // Set up polling
    pollRef.current = setInterval(() => {
      fetchAllInboxes(agents);
    }, pollInterval);

    return () => {
      if (pollRef.current) {
        clearInterval(pollRef.current);
      }
    };
  }, [agents.join(','), pollInterval, enabled, fetchAllInboxes]);

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
    fetchAllInboxes(agents);
  }, [agents, fetchAllInboxes]);

  // Total unread across all agents
  const totalUnread = Object.values(mailboxes).reduce(
    (sum, mb) => sum + (mb?.unreadCount || 0),
    0
  );

  // Get unread count for specific agent
  const getUnreadCount = useCallback((agent: string) => {
    return mailboxes[agent]?.unreadCount || 0;
  }, [mailboxes]);

  // Get messages for specific agent
  const getMessages = useCallback((agent: string) => {
    return mailboxes[agent]?.messages || [];
  }, [mailboxes]);

  // Check if loading for specific agent
  const isLoading = useCallback((agent: string) => {
    return mailboxes[agent]?.loading || false;
  }, [mailboxes]);

  return {
    // State
    mailboxes,
    selectedMessage,
    selectedMessageActions,
    selectedMessageSuggested,
    isComposing,
    replyTo,
    totalUnread,

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
  };
}
