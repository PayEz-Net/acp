import { create } from 'zustand';
import { useAppStore } from './appStore';

export interface ChatMessage {
  id: string;
  conversationId: string;
  from: string;
  body: string;
  createdAt: string;
}

export interface Conversation {
  id: string;
  participants: string[];
  lastMessage?: ChatMessage;
  unreadCount: number;
  createdAt: string;
}

async function chatRequest(endpoint: string, options: { method?: string; body?: unknown } = {}): Promise<Response> {
  const { method = 'GET', body } = options;
  const secret = await window.electronAPI.getLocalSecret();
  return fetch(`http://127.0.0.1:3001/v1/chat${endpoint}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(secret ? { 'Authorization': `Bearer ${secret}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

interface ChatStore {
  conversations: Conversation[];
  selectedConversation: Conversation | null;
  messages: ChatMessage[];
  loading: boolean;
  error?: string;

  fetchConversations: () => Promise<void>;
  selectConversation: (conv: Conversation) => Promise<void>;
  sendMessage: (conversationId: string, from: string, body: string) => Promise<boolean>;
  startConversation: (participants: string[]) => Promise<string | null>;
  updateFromSse: (data: Record<string, unknown>) => void;
}

export const useChatStore = create<ChatStore>((set, get) => ({
  conversations: [],
  selectedConversation: null,
  messages: [],
  loading: false,

  fetchConversations: async () => {
    if (!useAppStore.getState().backendAvailable) return;
    set({ loading: true });
    try {
      const res = await chatRequest('/conversations');
      if (!res.ok) throw new Error(`${res.status}`);
      const data = await res.json();
      set({ conversations: data.data || data.conversations || [], loading: false });
    } catch (err) {
      console.error('[Chat] Failed to fetch conversations:', err);
      set({ loading: false, error: 'Failed to fetch conversations' });
    }
  },

  selectConversation: async (conv) => {
    set({ selectedConversation: conv, messages: [], loading: true });
    try {
      const res = await chatRequest(`/conversations/${conv.id}/messages`);
      if (!res.ok) throw new Error(`${res.status}`);
      const data = await res.json();
      set({
        messages: data.data || data.messages || [],
        loading: false,
        // Mark as read
        conversations: get().conversations.map(c =>
          c.id === conv.id ? { ...c, unreadCount: 0 } : c
        ),
      });
    } catch (err) {
      console.error('[Chat] Failed to fetch messages:', err);
      set({ loading: false });
    }
  },

  sendMessage: async (conversationId, from, body) => {
    try {
      const res = await chatRequest(`/conversations/${conversationId}/messages`, {
        method: 'POST',
        body: { from, body },
      });
      if (!res.ok) throw new Error(`${res.status}`);
      const data = await res.json();
      const msg: ChatMessage = data.data || data;
      set((state) => ({ messages: [...state.messages, msg] }));
      return true;
    } catch (err) {
      console.error('[Chat] Failed to send:', err);
      return false;
    }
  },

  startConversation: async (participants) => {
    try {
      const res = await chatRequest('/conversations', {
        method: 'POST',
        body: { participants },
      });
      if (!res.ok) throw new Error(`${res.status}`);
      const data = await res.json();
      const conv: Conversation = data.data || data;
      set((state) => ({ conversations: [conv, ...state.conversations] }));
      return conv.id;
    } catch (err) {
      console.error('[Chat] Failed to start conversation:', err);
      return null;
    }
  },

  updateFromSse: (data) => {
    const msg = data as unknown as ChatMessage;
    if (!msg.conversationId) return;

    const { selectedConversation } = get();

    // If viewing this conversation, append message
    if (selectedConversation?.id === msg.conversationId) {
      set((state) => ({ messages: [...state.messages, msg] }));
    } else {
      // Increment unread
      set((state) => ({
        conversations: state.conversations.map(c =>
          c.id === msg.conversationId ? { ...c, unreadCount: c.unreadCount + 1, lastMessage: msg } : c
        ),
      }));
    }
  },
}));
