// ACP Agent Chat — VibeSQL persistence layer
// Direct VibeSQL access (POST /v1/query with raw SQL), not Vibe Public API proxy.

import { readFileSync } from 'node:fs';
import { monotonicFactory } from 'ulid';

const ulid = monotonicFactory();
import type {
  Conversation, Participant, Thread, ThreadSubscription,
  Message, Attachment, Reaction, DeliveryRecord,
  CreateConversationInput, AddParticipantInput, CreateThreadInput,
  SendMessageInput, CreateAttachmentInput,
  PaginatedMessages, UnreadCount, ThreadActivity,
  VibeQueryResult, SubscriptionLevel, DeliveryStatus, ThreadStatus,
} from './types.js';

// ─── SQL escaping (ported from storage/vibesql_client.js) ────────────

export function escapeSql(value: unknown): string {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return 'NULL';
    return String(value);
  }
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  return '\'' + String(value).replace(/'/g, '\'\'') + '\'';
}

export function escapeJsonb(obj: unknown): string {
  return '\'' + JSON.stringify(obj).replace(/'/g, '\'\'') + '\'::jsonb';
}

function escapeSqlArray(arr: string[]): string {
  if (!arr || arr.length === 0) return '\'{}\'';
  const escaped = arr.map(v => '"' + String(v).replace(/"/g, '\\"') + '"').join(',');
  return '\'{' + escaped + '}\'';
}

// ─── VibeSQL query client ────────────────────────────────────────────

export interface VibeQueryClientConfig {
  vibesqlDirectUrl: string;
  vibesqlContainerSecret?: string;
}

export class VibeQueryClient {
  private url: string;
  private secret?: string;

  constructor(config: VibeQueryClientConfig) {
    this.url = `${config.vibesqlDirectUrl}/v1/query`;
    this.secret = config.vibesqlContainerSecret;
  }

  async query(sql: string): Promise<VibeQueryResult> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.secret) {
      headers['Authorization'] = `Secret ${this.secret}`;
    }
    const res = await fetch(this.url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ sql }),
    });
    const data: VibeQueryResult = await res.json() as VibeQueryResult;
    if (!data.success) {
      const err = new Error(data.error?.message || 'VibeSQL query failed') as Error & {
        code?: string; detail?: string; statusCode?: number;
      };
      err.code = data.error?.code || 'INTERNAL_ERROR';
      err.detail = data.error?.detail;
      err.statusCode = res.status;
      throw err;
    }
    if (data.rows === undefined) {
      data.rows = [];
    }
    return data;
  }
}

// ─── ChatPersistence ─────────────────────────────────────────────────

export class ChatPersistence {
  private db: VibeQueryClient;

  constructor(db: VibeQueryClient) {
    this.db = db;
  }

  // ── Migration ────────────────────────────────────────────────────

  async runMigration(schemaPath: string): Promise<{ total: number; succeeded: number; failed: string[] }> {
    const sql = readFileSync(schemaPath, 'utf-8');
    const statements = sql
      .split(';')
      .map(s => s.trim())
      .filter(s => s.length > 0 && !s.startsWith('--'));

    let succeeded = 0;
    const failed: string[] = [];

    for (const stmt of statements) {
      try {
        await this.db.query(stmt);
        succeeded++;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        failed.push(msg);
      }
    }

    return { total: statements.length, succeeded, failed };
  }

  // ── Conversations ────────────────────────────────────────────────

  async createConversation(input: CreateConversationInput): Promise<Conversation> {
    const id = ulid();
    const now = new Date().toISOString();
    const metadata = input.metadata || {};

    await this.db.query(`INSERT INTO acp_conversations
      (id, title, type, state, project_id, metadata, created_at, updated_at)
      VALUES (
        ${escapeSql(id)},
        ${escapeSql(input.title)},
        ${escapeSql(input.type)},
        ${escapeSql(input.state || 'active')},
        ${escapeSql(input.projectId ?? null)},
        ${escapeJsonb(metadata)},
        ${escapeSql(now)},
        ${escapeSql(now)}
      )`);

    return {
      id, title: input.title, type: input.type,
      state: input.state || 'active',
      projectId: input.projectId ?? null,
      metadata, createdAt: now, updatedAt: now,
    };
  }

  async getConversation(id: string): Promise<Conversation | null> {
    const result = await this.db.query(
      `SELECT * FROM acp_conversations WHERE id = ${escapeSql(id)}`
    );
    if (!result.rows || result.rows.length === 0) return null;
    return this.rowToConversation(result.rows[0]);
  }

  async getConversationsByIds(ids: string[]): Promise<Conversation[]> {
    if (ids.length === 0) return [];
    const inClause = ids.map(id => escapeSql(id)).join(', ');
    const result = await this.db.query(
      `SELECT * FROM acp_conversations WHERE id IN (${inClause})`
    );
    return (result.rows || []).map((r: Record<string, unknown>) => this.rowToConversation(r));
  }

  // ── Participants ─────────────────────────────────────────────────

  async addParticipant(conversationId: string, input: AddParticipantInput): Promise<Participant> {
    const now = new Date().toISOString();
    await this.db.query(`INSERT INTO acp_conversation_participants
      (conversation_id, participant_id, participant_type, display_name, joined_at)
      VALUES (
        ${escapeSql(conversationId)},
        ${escapeSql(input.participantId)},
        ${escapeSql(input.participantType)},
        ${escapeSql(input.displayName)},
        ${escapeSql(now)}
      )`);

    return {
      conversationId,
      participantId: input.participantId,
      participantType: input.participantType,
      displayName: input.displayName,
      joinedAt: now,
      leftAt: null,
    };
  }

  async removeParticipant(conversationId: string, participantId: string): Promise<void> {
    const now = new Date().toISOString();
    await this.db.query(`UPDATE acp_conversation_participants
      SET left_at = ${escapeSql(now)}
      WHERE conversation_id = ${escapeSql(conversationId)}
        AND participant_id = ${escapeSql(participantId)}`);
  }

  async getParticipants(conversationId: string): Promise<Participant[]> {
    const result = await this.db.query(
      `SELECT * FROM acp_conversation_participants
       WHERE conversation_id = ${escapeSql(conversationId)} AND left_at IS NULL
       ORDER BY joined_at`
    );
    return (result.rows || []).map(r => this.rowToParticipant(r));
  }

  // ── Threads ──────────────────────────────────────────────────────

  async createThread(input: CreateThreadInput): Promise<Thread> {
    const id = `${input.conversationId}::${input.slug}`;
    const now = new Date().toISOString();

    await this.db.query(`INSERT INTO acp_threads
      (id, conversation_id, subject, status, created_at, updated_at)
      VALUES (
        ${escapeSql(id)},
        ${escapeSql(input.conversationId)},
        ${escapeSql(input.subject || '')},
        'open',
        ${escapeSql(now)},
        ${escapeSql(now)}
      )`);

    return {
      id,
      conversationId: input.conversationId,
      subject: input.subject || '',
      status: 'open',
      createdAt: now,
      updatedAt: now,
    };
  }

  async getThread(id: string): Promise<Thread | null> {
    const result = await this.db.query(
      `SELECT * FROM acp_threads WHERE id = ${escapeSql(id)}`
    );
    if (!result.rows || result.rows.length === 0) return null;
    return this.rowToThread(result.rows[0]);
  }

  async updateThreadStatus(id: string, status: ThreadStatus): Promise<void> {
    const now = new Date().toISOString();
    await this.db.query(`UPDATE acp_threads
      SET status = ${escapeSql(status)}, updated_at = ${escapeSql(now)}
      WHERE id = ${escapeSql(id)}`);
  }

  // ── Subscriptions ────────────────────────────────────────────────

  async setSubscription(threadId: string, participantId: string, level: SubscriptionLevel): Promise<void> {
    await this.db.query(`INSERT INTO acp_thread_subscriptions
      (thread_id, participant_id, level)
      VALUES (${escapeSql(threadId)}, ${escapeSql(participantId)}, ${escapeSql(level)})
      ON CONFLICT (thread_id, participant_id)
      DO UPDATE SET level = ${escapeSql(level)}`);
  }

  async getSubscription(threadId: string, participantId: string): Promise<ThreadSubscription | null> {
    const result = await this.db.query(
      `SELECT * FROM acp_thread_subscriptions
       WHERE thread_id = ${escapeSql(threadId)} AND participant_id = ${escapeSql(participantId)}`
    );
    if (!result.rows || result.rows.length === 0) return null;
    const row = result.rows[0];
    return {
      threadId: String(row.thread_id),
      participantId: String(row.participant_id),
      level: String(row.level) as SubscriptionLevel,
    };
  }

  // ── Messages ─────────────────────────────────────────────────────

  async sendMessage(input: SendMessageInput): Promise<Message> {
    const id = ulid();
    const now = new Date().toISOString();
    const flags = input.flags || [];

    await this.db.query(`INSERT INTO acp_messages
      (id, thread_id, author_id, text, formatted, raw, parent_message_id, dedupe_key, flags, created_at, updated_at)
      VALUES (
        ${escapeSql(id)},
        ${escapeSql(input.threadId)},
        ${escapeSql(input.authorId)},
        ${escapeSql(input.text)},
        ${escapeSql(input.formatted ?? null)},
        ${input.raw ? escapeJsonb(input.raw) : 'NULL'},
        ${escapeSql(input.parentMessageId ?? null)},
        ${escapeSql(input.dedupeKey ?? null)},
        ${escapeSqlArray(flags)},
        ${escapeSql(now)},
        ${escapeSql(now)}
      )`);

    return {
      id, threadId: input.threadId, authorId: input.authorId,
      text: input.text,
      formatted: input.formatted ?? null,
      raw: input.raw ?? null,
      parentMessageId: input.parentMessageId ?? null,
      dedupeKey: input.dedupeKey ?? null,
      flags, createdAt: now, updatedAt: now, deletedAt: null,
    };
  }

  async getMessages(threadId: string, afterCursor?: string, limit: number = 100): Promise<PaginatedMessages> {
    const fetchLimit = limit + 1; // fetch one extra to determine has_more
    const cursorClause = afterCursor
      ? `AND id > ${escapeSql(afterCursor)}`
      : '';

    const result = await this.db.query(
      `SELECT * FROM acp_messages
       WHERE thread_id = ${escapeSql(threadId)} AND deleted_at IS NULL ${cursorClause}
       ORDER BY id ASC
       LIMIT ${fetchLimit}`
    );

    const rows = result.rows || [];
    const hasMore = rows.length > limit;
    const messageRows = hasMore ? rows.slice(0, limit) : rows;
    const messages = messageRows.map(r => this.rowToMessage(r));
    const nextCursor = messages.length > 0 ? messages[messages.length - 1].id : null;

    return { messages, hasMore, nextCursor };
  }

  // ── Unread counts (spec section 6.2) ─────────────────────────────

  async getUnreadCounts(participantId: string): Promise<UnreadCount[]> {
    const result = await this.db.query(
      `SELECT t.conversation_id, COUNT(*) as unread
       FROM acp_messages m
       JOIN acp_threads t ON m.thread_id = t.id
       JOIN acp_thread_subscriptions s ON s.thread_id = t.id AND s.participant_id = ${escapeSql(participantId)}
       LEFT JOIN acp_delivery d ON d.message_id = m.id AND d.participant_id = ${escapeSql(participantId)}
       WHERE d.read_at IS NULL AND s.level = 'subscribed' AND m.deleted_at IS NULL
       GROUP BY t.conversation_id`
    );

    return (result.rows || []).map(r => ({
      conversationId: String(r.conversation_id),
      unread: Number(r.unread),
    }));
  }

  // ── Thread activity feed (spec section 6.2) ──────────────────────

  async getThreadActivity(participantId: string): Promise<ThreadActivity[]> {
    const result = await this.db.query(
      `SELECT t.*, MAX(m.created_at) as last_activity
       FROM acp_threads t
       JOIN acp_thread_subscriptions s ON s.thread_id = t.id AND s.participant_id = ${escapeSql(participantId)}
       LEFT JOIN acp_messages m ON m.thread_id = t.id AND m.deleted_at IS NULL
       WHERE s.level = 'subscribed'
       GROUP BY t.id, t.conversation_id, t.subject, t.status, t.created_at, t.updated_at
       ORDER BY last_activity DESC`
    );

    return (result.rows || []).map(r => ({
      id: String(r.id),
      conversationId: String(r.conversation_id),
      subject: String(r.subject),
      status: String(r.status) as ThreadStatus,
      createdAt: String(r.created_at),
      updatedAt: String(r.updated_at),
      lastActivity: r.last_activity ? String(r.last_activity) : null,
    }));
  }

  // ── Delivery tracking ────────────────────────────────────────────

  async trackDelivery(messageId: string, participantId: string, status: DeliveryStatus): Promise<void> {
    const now = new Date().toISOString();
    const deliveredAt = status === 'delivered' || status === 'read' ? `${escapeSql(now)}` : 'NULL';
    const readAt = status === 'read' ? `${escapeSql(now)}` : 'NULL';

    await this.db.query(`INSERT INTO acp_delivery
      (message_id, participant_id, status, created_at, delivered_at, read_at)
      VALUES (
        ${escapeSql(messageId)},
        ${escapeSql(participantId)},
        ${escapeSql(status)},
        ${escapeSql(now)},
        ${deliveredAt},
        ${readAt}
      )
      ON CONFLICT (message_id, participant_id)
      DO UPDATE SET
        status = ${escapeSql(status)},
        delivered_at = COALESCE(acp_delivery.delivered_at, ${deliveredAt}),
        read_at = COALESCE(acp_delivery.read_at, ${readAt}),
        retry_count = CASE
          WHEN ${escapeSql(status)} = 'undeliverable' THEN acp_delivery.retry_count + 1
          ELSE acp_delivery.retry_count
        END`);
  }

  async getDelivery(messageId: string, participantId: string): Promise<DeliveryRecord | null> {
    const result = await this.db.query(
      `SELECT * FROM acp_delivery
       WHERE message_id = ${escapeSql(messageId)} AND participant_id = ${escapeSql(participantId)}`
    );
    if (!result.rows || result.rows.length === 0) return null;
    const r = result.rows[0];
    return {
      messageId: String(r.message_id),
      participantId: String(r.participant_id),
      status: String(r.status) as DeliveryStatus,
      createdAt: String(r.created_at),
      deliveredAt: r.delivered_at ? String(r.delivered_at) : null,
      readAt: r.read_at ? String(r.read_at) : null,
      retryCount: Number(r.retry_count),
    };
  }

  // ── Reactions ────────────────────────────────────────────────────

  async addReaction(messageId: string, participantId: string, emoji: string): Promise<void> {
    const now = new Date().toISOString();
    await this.db.query(`INSERT INTO acp_reactions
      (message_id, participant_id, emoji, created_at)
      VALUES (
        ${escapeSql(messageId)},
        ${escapeSql(participantId)},
        ${escapeSql(emoji)},
        ${escapeSql(now)}
      )
      ON CONFLICT (message_id, participant_id, emoji) DO NOTHING`);
  }

  async getReactions(messageId: string): Promise<Reaction[]> {
    const result = await this.db.query(
      `SELECT * FROM acp_reactions WHERE message_id = ${escapeSql(messageId)} ORDER BY created_at`
    );
    return (result.rows || []).map(r => ({
      messageId: String(r.message_id),
      participantId: String(r.participant_id),
      emoji: String(r.emoji),
      createdAt: String(r.created_at),
    }));
  }

  // ── Attachments ──────────────────────────────────────────────────

  async createAttachment(input: CreateAttachmentInput): Promise<Attachment> {
    const id = ulid();
    const now = new Date().toISOString();

    await this.db.query(`INSERT INTO acp_attachments
      (id, message_id, type, name, mime_type, size_bytes, storage_ref, created_at)
      VALUES (
        ${escapeSql(id)},
        ${escapeSql(input.messageId)},
        ${escapeSql(input.type)},
        ${escapeSql(input.name)},
        ${escapeSql(input.mimeType ?? null)},
        ${escapeSql(input.sizeBytes ?? null)},
        ${escapeSql(input.storageRef)},
        ${escapeSql(now)}
      )`);

    return {
      id, messageId: input.messageId, type: input.type,
      name: input.name, mimeType: input.mimeType ?? null,
      sizeBytes: input.sizeBytes ?? null,
      storageRef: input.storageRef, createdAt: now,
    };
  }

  // ── Row mappers ──────────────────────────────────────────────────

  private rowToConversation(r: Record<string, unknown>): Conversation {
    let metadata = r.metadata;
    if (typeof metadata === 'string') {
      try { metadata = JSON.parse(metadata); } catch { metadata = {}; }
    }
    return {
      id: String(r.id),
      title: String(r.title),
      type: String(r.type) as Conversation['type'],
      state: String(r.state) as Conversation['state'],
      projectId: r.project_id ? String(r.project_id) : null,
      metadata: (metadata || {}) as Record<string, unknown>,
      createdAt: String(r.created_at),
      updatedAt: String(r.updated_at),
    };
  }

  private rowToParticipant(r: Record<string, unknown>): Participant {
    return {
      conversationId: String(r.conversation_id),
      participantId: String(r.participant_id),
      participantType: String(r.participant_type) as Participant['participantType'],
      displayName: String(r.display_name),
      joinedAt: String(r.joined_at),
      leftAt: r.left_at ? String(r.left_at) : null,
    };
  }

  private rowToThread(r: Record<string, unknown>): Thread {
    return {
      id: String(r.id),
      conversationId: String(r.conversation_id),
      subject: String(r.subject),
      status: String(r.status) as ThreadStatus,
      createdAt: String(r.created_at),
      updatedAt: String(r.updated_at),
    };
  }

  private rowToMessage(r: Record<string, unknown>): Message {
    let raw = r.raw;
    if (typeof raw === 'string') {
      try { raw = JSON.parse(raw); } catch { raw = null; }
    }
    let flags = r.flags;
    if (typeof flags === 'string') {
      // PostgreSQL TEXT[] may come back as '{flag1,flag2}' string
      flags = String(flags).replace(/^\{|\}$/g, '').split(',').filter(Boolean);
    }
    if (!Array.isArray(flags)) flags = [];

    return {
      id: String(r.id),
      threadId: String(r.thread_id),
      authorId: String(r.author_id),
      text: String(r.text),
      formatted: r.formatted ? String(r.formatted) : null,
      raw: (raw || null) as Record<string, unknown> | null,
      parentMessageId: r.parent_message_id ? String(r.parent_message_id) : null,
      dedupeKey: r.dedupe_key ? String(r.dedupe_key) : null,
      flags: flags as Message['flags'],
      createdAt: String(r.created_at),
      updatedAt: String(r.updated_at),
      deletedAt: r.deleted_at ? String(r.deleted_at) : null,
    };
  }
}
