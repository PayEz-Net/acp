import { create } from 'zustand';
import { MailMessage, AgentMailbox, PanelAction } from '@shared/types';

const AGENT_MAIL_API = 'http://localhost:37933/v1/agentmail';
const USE_MOCK_DATA = false;

// -----------------------------------------------------------------------------
// HMAC Authentication (Client ID + Signature - free tier pattern)
// -----------------------------------------------------------------------------

// Cache credentials to avoid repeated IPC calls
let credentialsCache: { clientId: string; hmacKey: string } | null = null;

// Get credentials from electron store or environment
async function getVibeCredentials(): Promise<{ clientId: string; hmacKey: string }> {
  // Return cached credentials if available
  if (credentialsCache) {
    return credentialsCache;
  }

  // In Electron, get credentials from main process via preload
  if (window.electronAPI?.getVibeCredentials) {
    try {
      const creds = await window.electronAPI.getVibeCredentials();
      credentialsCache = creds;
      return creds;
    } catch (err) {
      console.error('[Mail] Failed to get Vibe credentials:', err);
    }
  }

  // Fallback: check if injected globally (for testing)
  const global = window as unknown as { VIBE_CLIENT_ID?: string; VIBE_HMAC_KEY?: string };
  return {
    clientId: global.VIBE_CLIENT_ID || '',
    hmacKey: global.VIBE_HMAC_KEY || '',
  };
}

/**
 * Generate HMAC-SHA256 signature using Web Crypto API
 * Payload format: {timestamp}|{METHOD}|{path}
 */
async function generateHmacSignature(secret: string, payload: string): Promise<string> {
  const encoder = new TextEncoder();

  // DotNetPert said key is base64 encoded, so decode it first
  const keyData = Uint8Array.from(atob(secret), c => c.charCodeAt(0));
  const messageData = encoder.encode(payload);

  // Import the secret as an HMAC key
  const key = await crypto.subtle.importKey(
    'raw',
    keyData,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );

  // Sign the payload
  const signature = await crypto.subtle.sign('HMAC', key, messageData);

  // Convert to base64
  const bytes = new Uint8Array(signature);
  let binary = '';
  bytes.forEach(b => binary += String.fromCharCode(b));
  return btoa(binary);
}

// Helper to make authenticated requests to Agent Mail API
async function mailRequest(endpoint: string, options: { method?: string; body?: unknown } = {}) {
  const { method = 'GET', body } = options;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };

  // Add HMAC auth headers
  const { clientId, hmacKey } = await getVibeCredentials();
  if (clientId && hmacKey) {
    const timestamp = Math.floor(Date.now() / 1000);
    const signaturePayload = `${timestamp}|${method}|${endpoint}`;

    try {
      const signature = await generateHmacSignature(hmacKey, signaturePayload);
      headers['X-Vibe-Client-Id'] = clientId;
      headers['X-Vibe-Timestamp'] = timestamp.toString();
      headers['X-Vibe-Signature'] = signature;
    } catch (err) {
      console.error('[Mail] HMAC signature generation failed:', err);
    }
  }

  return fetch(`${AGENT_MAIL_API}${endpoint}`, {
    method,
    headers,
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
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

  // Actions
  setMailbox: (agent: string, mailbox: Partial<ExtendedMailbox>) => void;
  selectMessage: (message: MailMessage | null) => void;
  setComposing: (isComposing: boolean, replyTo?: MailMessage | null) => void;
  markAsRead: (messageId: number) => void;

  // API actions
  fetchInbox: (agent: string) => Promise<void>;
  fetchAllInboxes: (agents: string[]) => Promise<void>;
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
      // Call the new ActionPanel-formatted endpoint
      const res = await mailRequest(`/inbox/${encodeURIComponent(agent)}`);

      if (!res.ok) {
        throw new Error(`Failed to fetch: ${res.status}`);
      }

      const response = await res.json();

      // Parse ActionPanel response format
      // { success, data: { agent, messages }, pagination, actions, suggested }
      if (!response.success) {
        throw new Error(response.error || 'Request failed');
      }

      const messages: MailMessage[] = response.data?.messages || [];

      setMailbox(agent, {
        messages,
        unreadCount: messages.filter((m) => !m.is_read).length,
        loading: false,
        actions: response.actions,
        suggested: response.suggested,
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
      const message: MailMessage = response.data;

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
      const res = await mailRequest('/send', {
        method: 'POST',
        body: {
          from_agent: from,
          to_agent: to,
          subject,
          body,
        },
      });

      if (!res.ok) {
        throw new Error(`Failed to send: ${res.status}`);
      }

      const response = await res.json();

      if (!response.success) {
        throw new Error(response.error || 'Send failed');
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
          await markMessageRead(action.params.id as number);
          // Refresh the inbox for the message recipient
          if (selectedMessage) {
            await fetchInbox(selectedMessage.to_agent);
          }
        }
        break;

      case 'check_inbox':
        // Refresh all mailboxes
        const agents = Object.keys(get().mailboxes);
        await Promise.all(agents.map(agent => fetchInbox(agent)));
        break;

      default:
        console.warn(`[Mail] Unknown action: ${action.action}`);
    }
  },
}));

// Mark message as read on server
export async function markMessageRead(messageId: number): Promise<boolean> {
  try {
    const res = await mailRequest(`/inbox/${messageId}/read`, { method: 'POST' });
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
