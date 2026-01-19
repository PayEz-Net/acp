import { useEffect, useRef, useCallback } from 'react';
import { useMailStore, markMessageRead } from '../stores/mailStore';
import { MailMessage } from '@shared/types';

interface UseMailOptions {
  agents: string[];
  pollInterval?: number;
  enabled?: boolean;
}

export function useMail({ agents, pollInterval = 30000, enabled = true }: UseMailOptions) {
  const {
    mailboxes,
    selectedMessage,
    isComposing,
    replyTo,
    fetchAllInboxes,
    selectMessage,
    setComposing,
    markAsRead,
    sendMessage,
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

  // Handle message selection and mark as read
  const handleSelectMessage = useCallback(async (message: MailMessage | null) => {
    selectMessage(message);

    if (message && !message.is_read) {
      const success = await markMessageRead(message.message_id);
      if (success) {
        markAsRead(message.message_id);
      }
    }
  }, [selectMessage, markAsRead]);

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
    refresh,
  };
}
