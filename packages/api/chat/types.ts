// ACP Agent Chat — Type definitions (from spec v1.1, section 3)

// ─── Enums ───────────────────────────────────────────────────────────

export type ConversationType = 'direct' | 'group' | 'channel';
export type ConversationState = 'active' | 'resolved' | 'archived';
export type ThreadStatus = 'open' | 'resolved';
export type SubscriptionLevel = 'subscribed' | 'mention-only' | 'muted';
export type MessageFlag = 'system' | 'actionRequired' | 'decision' | 'fyi';
export type DeliveryStatus = 'pending' | 'delivered' | 'read' | 'undeliverable';
export type ParticipantType = 'agent' | 'human' | 'system';
export type AttachmentType = 'file' | 'image' | 'code' | 'spec' | 'artifact';

// ─── Core entities ───────────────────────────────────────────────────

export interface Conversation {
  id: string;                       // ULID
  title: string;
  type: ConversationType;
  state: ConversationState;
  projectId?: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;                // ISO 8601
  updatedAt: string;
}

export interface Participant {
  conversationId: string;
  participantId: string;            // "agent:BAPert", "human:jon"
  participantType: ParticipantType;
  displayName: string;
  joinedAt: string;
  leftAt?: string | null;
}

export interface Thread {
  id: string;                       // "{conversationId}::{slug}"
  conversationId: string;
  subject: string;
  status: ThreadStatus;
  createdAt: string;
  updatedAt: string;
}

export interface ThreadSubscription {
  threadId: string;
  participantId: string;
  level: SubscriptionLevel;
}

export interface Message {
  id: string;                       // ULID (time-sortable)
  threadId: string;
  authorId: string;                 // participant ID
  text: string;
  formatted?: string | null;        // markdown or HTML
  raw?: Record<string, unknown> | null;  // structured escape hatch
  parentMessageId?: string | null;  // reply-to
  dedupeKey?: string | null;        // idempotent delivery
  flags: MessageFlag[];
  createdAt: string;
  updatedAt: string;
  deletedAt?: string | null;        // soft delete
}

export interface Attachment {
  id: string;
  messageId: string;
  type: AttachmentType;
  name: string;
  mimeType?: string | null;
  sizeBytes?: number | null;
  storageRef: string;               // path or URL
  createdAt: string;
}

export interface Reaction {
  messageId: string;
  participantId: string;
  emoji: string;
  createdAt: string;
}

export interface DeliveryRecord {
  messageId: string;
  participantId: string;
  status: DeliveryStatus;
  createdAt: string;
  deliveredAt?: string | null;
  readAt?: string | null;
  retryCount: number;
}

// ─── Input types (for create operations) ─────────────────────────────

export interface CreateConversationInput {
  title: string;
  type: ConversationType;
  state?: ConversationState;
  projectId?: string | null;
  metadata?: Record<string, unknown>;
}

export interface AddParticipantInput {
  participantId: string;
  participantType: ParticipantType;
  displayName: string;
}

export interface CreateThreadInput {
  conversationId: string;
  slug: string;
  subject?: string;
}

export interface SendMessageInput {
  threadId: string;
  authorId: string;
  text: string;
  formatted?: string | null;
  raw?: Record<string, unknown> | null;
  parentMessageId?: string | null;
  dedupeKey?: string | null;
  flags?: MessageFlag[];
}

export interface CreateAttachmentInput {
  messageId: string;
  type: AttachmentType;
  name: string;
  mimeType?: string | null;
  sizeBytes?: number | null;
  storageRef: string;
}

// ─── Query results ───────────────────────────────────────────────────

export interface PaginatedMessages {
  messages: Message[];
  hasMore: boolean;
  nextCursor: string | null;
}

export interface UnreadCount {
  conversationId: string;
  unread: number;
}

export interface ThreadActivity {
  id: string;
  conversationId: string;
  subject: string;
  status: ThreadStatus;
  createdAt: string;
  updatedAt: string;
  lastActivity: string | null;
}

// ─── VibeSQL response ────────────────────────────────────────────────

export interface VibeQueryResult {
  success: boolean;
  rows?: Record<string, unknown>[];
  rowCount?: number;
  executionTime?: number;
  error?: {
    code: string;
    message: string;
    detail?: string;
  };
}
