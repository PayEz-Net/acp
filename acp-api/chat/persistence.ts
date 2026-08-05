// Phase 1: Stub chat persistence - no VibeSQL dependency
// Chat data is not persisted, stored in memory only

export class VibeQueryClient {
  private url: string;
  private secret: string | undefined;

  constructor(config: { vibesqlDirectUrl: string; vibesqlContainerSecret?: string }) {
    // Stub - no actual connection
    this.url = config.vibesqlDirectUrl || 'http://localhost';
    this.secret = config.vibesqlContainerSecret;
  }

  async query(_sql: string): Promise<any> {
    // Stub - returns empty result
    return { rows: [], rowCount: 0 };
  }
}

// In-memory storage for chat data
const memoryStore = {
  conversations: new Map<string, any>(),
  threads: new Map<string, any>(),
  messages: new Map<string, any[]>(),
  participants: new Map<string, any[]>(),
};

let idCounter = 1;
function generateId(): string {
  return `chat_${Date.now()}_${idCounter++}`;
}

export class ChatPersistence {
  private db: VibeQueryClient;

  constructor(db: VibeQueryClient) {
    this.db = db;
  }

  async createConversation(data: { title: string; type: string; projectId?: string | null; metadata?: any; state?: string }): Promise<any> {
    const id = generateId();
    const conv = {
      id,
      title: data.title,
      type: data.type,
      project_id: data.projectId || null,
      // Also camelCase: the list handler filters on `c.projectId` (routes/chat.ts
      // :78-82). With only snake_case present that read was always undefined, so
      // `!c.projectId` was always true and EVERY conversation passed the project
      // filter regardless of project. It looked correct because it never excluded
      // anything.
      projectId: data.projectId || null,
      metadata: data.metadata || {},
      state: data.state || 'active',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    memoryStore.conversations.set(id, conv);
    return conv;
  }

  async createThread(data: { conversationId: string; slug: string; subject: string; metadata?: any }): Promise<any> {
    // DETERMINISTIC id, not a sequential one. Both message handlers in
    // api/routes/chat.ts derive `${conversationId}::main` when no threadId is
    // supplied (send: :118-121, read: :148) — a convention this method used to
    // ignore, minting `chat_<ts>_<n>` instead. Conversation `..._7` got thread
    // `..._8`, so every message was written against a thread id that was never
    // created and no read could ever find it. The convention now holds.
    const id = `${data.conversationId}::${data.slug}`;
    const thread = {
      id,
      conversation_id: data.conversationId,
      slug: data.slug,
      subject: data.subject,
      metadata: data.metadata || {},
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    memoryStore.threads.set(id, thread);
    return thread;
  }

  async addMessage(data: { threadId: string; senderId: string; senderType: string; content: string; contentType?: string; metadata?: any }): Promise<any> {
    const id = generateId();
    const msg = {
      id,
      thread_id: data.threadId,
      sender_id: data.senderId,
      sender_type: data.senderType,
      content: data.content,
      content_type: data.contentType || 'text',
      metadata: data.metadata || {},
      created_at: new Date().toISOString(),
    };
    
    const threadMessages = memoryStore.messages.get(data.threadId) || [];
    threadMessages.push(msg);
    memoryStore.messages.set(data.threadId, threadMessages);
    
    return msg;
  }

  async addParticipant(conversationId: string, participant: { participantId: string; participantType: string; displayName: string }): Promise<any> {
    // Reject rather than persist a participant with no id. This used to accept
    // `undefined` and store an anonymous row, producing a conversation nobody
    // is in — which reads downstream as "the observer never messaged me"
    // instead of "the request was malformed".
    if (!participant?.participantId) {
      throw new Error('addParticipant requires participantId');
    }
    const p = {
      conversation_id: conversationId,
      participant_id: participant.participantId,
      participant_type: participant.participantType,
      display_name: participant.displayName,
      joined_at: new Date().toISOString(),
    };
    
    const participants = memoryStore.participants.get(conversationId) || [];
    participants.push(p);
    memoryStore.participants.set(conversationId, participants);
    
    return p;
  }

  async getConversation(id: string): Promise<any | null> {
    return memoryStore.conversations.get(id) || null;
  }

  async getThread(id: string): Promise<any | null> {
    return memoryStore.threads.get(id) || null;
  }

  async getMessages(threadId: string, beforeOrLimit?: string | number, limit?: number): Promise<any[]> {
    // Stub - accepts (threadId) or (threadId, before, limit) signatures
    const messages = memoryStore.messages.get(threadId) || [];
    
    // If before (cursor) is provided, filter messages before that id
    if (typeof beforeOrLimit === 'string' && beforeOrLimit) {
      const beforeIndex = messages.findIndex((m: any) => m.id === beforeOrLimit);
      if (beforeIndex >= 0) {
        return messages.slice(0, beforeIndex).slice(-(limit || 50));
      }
    }
    
    // If limit is provided as second arg
    if (typeof beforeOrLimit === 'number') {
      return messages.slice(0, beforeOrLimit);
    }
    
    return messages;
  }

  async getParticipants(conversationId: string): Promise<any[]> {
    return memoryStore.participants.get(conversationId) || [];
  }

  async listConversations(_filters?: any): Promise<any[]> {
    return Array.from(memoryStore.conversations.values());
  }

  async updateConversation(id: string, updates: Partial<{ title: string; metadata: any }>): Promise<any | null> {
    const conv = memoryStore.conversations.get(id);
    if (!conv) return null;
    
    if (updates.title) conv.title = updates.title;
    if (updates.metadata) conv.metadata = { ...conv.metadata, ...updates.metadata };
    conv.updated_at = new Date().toISOString();
    
    return conv;
  }

  async deleteConversation(id: string): Promise<boolean> {
    return memoryStore.conversations.delete(id);
  }

  /**
   * Persist a chat message.
   *
   * This used to be `sendMessage(_data)` returning `{ id, delivered: true }` —
   * it discarded its argument and hardcoded the delivery flag, so every caller
   * was told the message was delivered and nothing was ever stored. The
   * observer<->lead line shipped on top of it and could never carry a message;
   * BAPert's boot prompt told it to poll a channel that would return empty
   * forever. `delivered` is now a statement about the store, not a literal.
   */
  async sendMessage(data: {
    threadId: string;
    authorId: string;
    text: string;
    formatted?: any;
    parentMessageId?: string | null;
  }): Promise<any> {
    if (!data?.threadId || !data?.authorId) {
      throw new Error('sendMessage requires threadId and authorId');
    }
    const msg = {
      id: generateId(),
      thread_id: data.threadId,
      author_id: data.authorId,
      authorId: data.authorId,          // both cases: routes and UI read either
      text: data.text ?? '',
      formatted: data.formatted ?? null,
      parent_message_id: data.parentMessageId ?? null,
      created_at: new Date().toISOString(),
    };

    const threadMessages = memoryStore.messages.get(data.threadId) || [];
    threadMessages.push(msg);
    memoryStore.messages.set(data.threadId, threadMessages);

    // Report from the store, not from the request — the whole point.
    const stored = (memoryStore.messages.get(data.threadId) || []).some((m: any) => m.id === msg.id);
    return { ...msg, delivered: stored };
  }

  async trackDelivery(_messageId: string, _status: string, _metadata?: any): Promise<void> {
    // Stub - no-op
  }

  async removeParticipant(_conversationId: string, _participantId: string): Promise<boolean> {
    // Stub - always returns true
    return true;
  }

  async setSubscription(_conversationId: string, _participantId: string, _subscribed: boolean | string): Promise<void> {
    // Stub - no-op
  }

  /**
   * Threads an agent can see, newest activity first.
   *
   * This returned `[]` unconditionally, which is what made the lead's own
   * `GET /v1/chat/conversations?agent=BAPert` — the exact call its boot prompt
   * instructs it to run on cycle — answer `{"threads":[]}` forever.
   *
   * Accepts an agent name (list that agent's threads) or an explicit list of
   * thread ids, matching both existing call shapes.
   */
  async getThreadActivity(threadIdsOrAgent: string[] | string): Promise<any[]> {
    const threadsFor = (threadId: string) => {
      const thread = memoryStore.threads.get(threadId);
      if (!thread) return null;
      const msgs = memoryStore.messages.get(threadId) || [];
      const last = msgs.length ? msgs[msgs.length - 1] : null;
      const conv = memoryStore.conversations.get(thread.conversation_id);
      return {
        conversationId: thread.conversation_id,
        conversationTitle: conv?.title ?? null,
        threadId: thread.id,
        slug: thread.slug,
        subject: thread.subject,
        messageCount: msgs.length,
        lastMessageAt: last?.created_at ?? thread.created_at,
        lastAuthorId: last?.author_id ?? null,
        lastText: last?.text ?? null,
      };
    };

    let rows: any[];
    if (Array.isArray(threadIdsOrAgent)) {
      rows = threadIdsOrAgent.map(threadsFor).filter(Boolean) as any[];
    } else {
      const agent = threadIdsOrAgent;
      const visible = new Set<string>();
      for (const [conversationId, participants] of memoryStore.participants) {
        if (!participants.some((p: any) => p.participant_id === agent)) continue;
        visible.add(conversationId);
      }
      rows = Array.from(memoryStore.threads.values())
        .filter((t: any) => visible.has(t.conversation_id))
        .map((t: any) => threadsFor(t.id))
        .filter(Boolean) as any[];
    }

    rows.sort((a, b) => String(b.lastMessageAt ?? '').localeCompare(String(a.lastMessageAt ?? '')));
    return rows;
  }

  /**
   * Unread per conversation for an agent: messages it did not author. Returned
   * `{}` unconditionally before, so the lead had no signal that the observer
   * had said anything even once threads were listable.
   */
  async getUnreadCounts(conversationIdsOrAgent: string[] | string, _participantId?: string): Promise<Record<string, number>> {
    const counts: Record<string, number> = {};
    const agent = Array.isArray(conversationIdsOrAgent) ? _participantId : conversationIdsOrAgent;
    if (!agent) return counts;

    const scope = Array.isArray(conversationIdsOrAgent) ? new Set(conversationIdsOrAgent) : null;
    for (const thread of memoryStore.threads.values()) {
      if (scope && !scope.has(thread.conversation_id)) continue;
      const participants = memoryStore.participants.get(thread.conversation_id) || [];
      if (!participants.some((p: any) => p.participant_id === agent)) continue;
      const unread = (memoryStore.messages.get(thread.id) || [])
        .filter((m: any) => m.author_id !== agent).length;
      if (unread > 0) {
        counts[thread.conversation_id] = (counts[thread.conversation_id] || 0) + unread;
      }
    }
    return counts;
  }

  async getConversationsByIds(ids: string[]): Promise<any[]> {
    // Stub - returns matching conversations from memory
    return ids.map(id => memoryStore.conversations.get(id)).filter(Boolean);
  }
}
