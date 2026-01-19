import { create } from 'zustand';
import { MailMessage, AgentMailbox } from '@shared/types';

const VIBE_API = 'https://api.idealvibe.online/api/vibe';

interface MailStore {
  // State per agent
  mailboxes: Record<string, AgentMailbox>;
  selectedMessage: MailMessage | null;
  isComposing: boolean;
  replyTo: MailMessage | null;

  // Actions
  setMailbox: (agent: string, mailbox: Partial<AgentMailbox>) => void;
  selectMessage: (message: MailMessage | null) => void;
  setComposing: (isComposing: boolean, replyTo?: MailMessage | null) => void;
  markAsRead: (messageId: number) => void;

  // API actions
  fetchInbox: (agent: string) => Promise<void>;
  fetchAllInboxes: (agents: string[]) => Promise<void>;
  sendMessage: (from: string, to: string, subject: string, body: string) => Promise<boolean>;
}

export const useMailStore = create<MailStore>((set, get) => ({
  mailboxes: {},
  selectedMessage: null,
  isComposing: false,
  replyTo: null,

  setMailbox: (agent, update) => set((state) => {
    const existing = state.mailboxes[agent] || {
      agent,
      messages: [],
      unreadCount: 0,
      loading: false,
    };
    return {
      mailboxes: {
        ...state.mailboxes,
        [agent]: { ...existing, ...update },
      },
    };
  }),

  selectMessage: (message) => set({ selectedMessage: message, isComposing: false }),

  setComposing: (isComposing, replyTo = null) => set({
    isComposing,
    replyTo,
    selectedMessage: null,
  }),

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

  fetchInbox: async (agent) => {
    const { setMailbox } = get();
    setMailbox(agent, { loading: true, error: undefined });

    try {
      const res = await fetch(`${VIBE_API}/query`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          collection: 'agent_messages',
          filter: { to_agent: agent },
          sort: { created_at: 'desc' },
          limit: 50
        })
      });

      if (!res.ok) {
        throw new Error(`Failed to fetch: ${res.status}`);
      }

      const data = await res.json();
      const messages: MailMessage[] = data.items || [];

      setMailbox(agent, {
        messages,
        unreadCount: messages.filter((m) => !m.is_read).length,
        loading: false,
      });
    } catch (err) {
      console.error(`[Mail] Failed to fetch inbox for ${agent}:`, err);
      setMailbox(agent, {
        loading: false,
        error: err instanceof Error ? err.message : 'Failed to fetch',
      });
    }
  },

  fetchAllInboxes: async (agents) => {
    const { fetchInbox } = get();
    await Promise.all(agents.map((agent) => fetchInbox(agent)));
  },

  sendMessage: async (from, to, subject, body) => {
    try {
      const res = await fetch(`${VIBE_API}/insert`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          collection: 'agent_messages',
          data: {
            from_agent: from,
            to_agent: to,
            subject,
            body,
            is_read: false,
            created_at: new Date().toISOString()
          }
        }),
      });

      if (!res.ok) {
        throw new Error(`Failed to send: ${res.status}`);
      }

      // Refresh recipient's inbox
      const { fetchInbox } = get();
      await fetchInbox(to);

      return true;
    } catch (err) {
      console.error('[Mail] Failed to send message:', err);
      return false;
    }
  },
}));

// Mark message as read on server
export async function markMessageRead(messageId: number): Promise<boolean> {
  try {
    const res = await fetch(`${VIBE_API}/update`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        collection: 'agent_messages',
        filter: { message_id: messageId },
        data: { is_read: true, read_at: new Date().toISOString() }
      })
    });
    return res.ok;
  } catch (err) {
    console.error('[Mail] Failed to mark as read:', err);
    return false;
  }
}
