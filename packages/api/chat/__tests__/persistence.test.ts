// ACP Agent Chat — Persistence layer tests
// Tests against mock VibeSQL (same pattern as existing __tests__/vibesql_client.test.js)

import { jest } from '@jest/globals';
import { ChatPersistence, VibeQueryClient, escapeSql, escapeJsonb } from '../persistence.js';

// ─── Test helpers ────────────────────────────────────────────────────

let mockResponses: Array<{ success: boolean; rows?: Record<string, unknown>[]; rowCount?: number }>;

function pushResponse(rows: Record<string, unknown>[] = [], success = true) {
  mockResponses.push({ success, rows, rowCount: rows.length });
}

function getLastSql(): string {
  const calls = (global.fetch as jest.Mock).mock.calls;
  const lastCall = calls[calls.length - 1] as [string, { body: string }];
  return JSON.parse(lastCall[1].body).sql;
}

function getAllSql(): string[] {
  return ((global.fetch as jest.Mock).mock.calls as [string, { body: string }][])
    .map(call => JSON.parse(call[1].body).sql);
}

// ─── Setup ───────────────────────────────────────────────────────────

let db: VibeQueryClient;
let persistence: ChatPersistence;

beforeEach(() => {
  mockResponses = [];
  (global as Record<string, unknown>).fetch = jest.fn(async () => {
    const response = mockResponses.shift() || { success: true, rows: [], rowCount: 0 };
    return { json: async () => response, ok: true, status: 200 };
  });
  db = new VibeQueryClient({ vibesqlDirectUrl: 'http://localhost:5173' });
  persistence = new ChatPersistence(db);
});

afterEach(() => {
  jest.restoreAllMocks();
  delete (global as Record<string, unknown>).fetch;
});

// ─── escapeSql / escapeJsonb ─────────────────────────────────────────

describe('escapeSql', () => {
  test('escapes null/undefined to NULL', () => {
    expect(escapeSql(null)).toBe('NULL');
    expect(escapeSql(undefined)).toBe('NULL');
  });

  test('escapes strings with single quotes', () => {
    expect(escapeSql('hello')).toBe("'hello'");
    expect(escapeSql("it's")).toBe("'it''s'");
  });

  test('escapes numbers', () => {
    expect(escapeSql(42)).toBe('42');
    expect(escapeSql(NaN)).toBe('NULL');
  });

  test('escapes booleans', () => {
    expect(escapeSql(true)).toBe('TRUE');
    expect(escapeSql(false)).toBe('FALSE');
  });
});

describe('escapeJsonb', () => {
  test('wraps object as JSONB', () => {
    const result = escapeJsonb({ key: 'value' });
    expect(result).toContain('::jsonb');
    expect(result).toContain('"key"');
  });
});

// ─── Conversations ───────────────────────────────────────────────────

describe('createConversation', () => {
  test('inserts and returns conversation with ULID', async () => {
    pushResponse(); // INSERT succeeds
    const conv = await persistence.createConversation({
      title: 'Test Conversation',
      type: 'group',
    });

    expect(conv.id).toMatch(/^[0-9A-Z]{26}$/); // ULID format
    expect(conv.title).toBe('Test Conversation');
    expect(conv.type).toBe('group');
    expect(conv.state).toBe('active');

    const sql = getLastSql();
    expect(sql).toContain('INSERT INTO acp_conversations');
    expect(sql).toContain('Test Conversation');
  });
});

describe('getConversation', () => {
  test('returns null when not found', async () => {
    pushResponse([]);
    const result = await persistence.getConversation('nonexistent');
    expect(result).toBeNull();
  });

  test('returns mapped conversation', async () => {
    pushResponse([{
      id: '01ABC', title: 'Test', type: 'direct', state: 'active',
      project_id: null, metadata: '{}', created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
    }]);
    const result = await persistence.getConversation('01ABC');
    expect(result).not.toBeNull();
    expect(result!.id).toBe('01ABC');
    expect(result!.type).toBe('direct');
  });
});

// ─── Participants ────────────────────────────────────────────────────

describe('addParticipant', () => {
  test('inserts participant record', async () => {
    pushResponse();
    const p = await persistence.addParticipant('conv1', {
      participantId: 'agent:BAPert',
      participantType: 'agent',
      displayName: 'BAPert',
    });

    expect(p.conversationId).toBe('conv1');
    expect(p.participantId).toBe('agent:BAPert');
    expect(p.participantType).toBe('agent');
    expect(getLastSql()).toContain('acp_conversation_participants');
  });
});

describe('removeParticipant', () => {
  test('sets left_at timestamp', async () => {
    pushResponse();
    await persistence.removeParticipant('conv1', 'agent:BAPert');
    expect(getLastSql()).toContain('UPDATE acp_conversation_participants');
    expect(getLastSql()).toContain('left_at');
  });
});

// ─── Threads ─────────────────────────────────────────────────────────

describe('createThread', () => {
  test('creates thread with composite ID', async () => {
    pushResponse();
    const thread = await persistence.createThread({
      conversationId: '01CONV',
      slug: 'main',
      subject: 'Main Thread',
    });

    expect(thread.id).toBe('01CONV::main');
    expect(thread.conversationId).toBe('01CONV');
    expect(thread.status).toBe('open');
    expect(getLastSql()).toContain('acp_threads');
  });
});

describe('getThread', () => {
  test('returns null when not found', async () => {
    pushResponse([]);
    expect(await persistence.getThread('nonexistent::main')).toBeNull();
  });
});

describe('updateThreadStatus', () => {
  test('updates status and updated_at', async () => {
    pushResponse();
    await persistence.updateThreadStatus('01CONV::main', 'resolved');
    const sql = getLastSql();
    expect(sql).toContain('UPDATE acp_threads');
    expect(sql).toContain("'resolved'");
  });
});

// ─── Subscriptions ───────────────────────────────────────────────────

describe('setSubscription', () => {
  test('upserts subscription level', async () => {
    pushResponse();
    await persistence.setSubscription('thread1', 'agent:BAPert', 'subscribed');
    const sql = getLastSql();
    expect(sql).toContain('acp_thread_subscriptions');
    expect(sql).toContain('ON CONFLICT');
    expect(sql).toContain("'subscribed'");
  });
});

describe('getSubscription', () => {
  test('returns null when not found', async () => {
    pushResponse([]);
    const result = await persistence.getSubscription('thread1', 'agent:BAPert');
    expect(result).toBeNull();
  });

  test('returns subscription when found', async () => {
    pushResponse([{ thread_id: 'thread1', participant_id: 'agent:BAPert', level: 'subscribed' }]);
    const result = await persistence.getSubscription('thread1', 'agent:BAPert');
    expect(result).not.toBeNull();
    expect(result!.level).toBe('subscribed');
  });
});

// ─── Messages ────────────────────────────────────────────────────────

describe('sendMessage', () => {
  test('generates ULID and inserts message', async () => {
    pushResponse();
    const msg = await persistence.sendMessage({
      threadId: '01CONV::main',
      authorId: 'agent:BAPert',
      text: 'Hello world',
      flags: ['fyi'],
    });

    expect(msg.id).toMatch(/^[0-9A-Z]{26}$/);
    expect(msg.threadId).toBe('01CONV::main');
    expect(msg.authorId).toBe('agent:BAPert');
    expect(msg.text).toBe('Hello world');
    expect(msg.flags).toEqual(['fyi']);
  });

  test('supports dedupeKey', async () => {
    pushResponse();
    const msg = await persistence.sendMessage({
      threadId: '01CONV::main',
      authorId: 'agent:BAPert',
      text: 'Deduplicated',
      dedupeKey: 'unique-key-123',
    });

    expect(msg.dedupeKey).toBe('unique-key-123');
    expect(getLastSql()).toContain('unique-key-123');
  });
});

describe('getMessages', () => {
  test('returns paginated messages with hasMore=false', async () => {
    pushResponse([
      { id: '01MSG1', thread_id: 't1', author_id: 'a1', text: 'msg1', formatted: null, raw: null, parent_message_id: null, dedupe_key: null, flags: '{}', created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z', deleted_at: null },
    ]);
    const result = await persistence.getMessages('t1');
    expect(result.messages).toHaveLength(1);
    expect(result.hasMore).toBe(false);
    expect(result.messages[0].text).toBe('msg1');
  });

  test('returns hasMore=true when more rows exist', async () => {
    // 101 rows = 100 messages + has_more flag
    const rows = Array.from({ length: 101 }, (_, i) => ({
      id: `01MSG${String(i).padStart(3, '0')}`, thread_id: 't1', author_id: 'a1',
      text: `msg${i}`, formatted: null, raw: null, parent_message_id: null,
      dedupe_key: null, flags: '{}',
      created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z', deleted_at: null,
    }));
    pushResponse(rows);
    const result = await persistence.getMessages('t1');
    expect(result.messages).toHaveLength(100);
    expect(result.hasMore).toBe(true);
  });

  test('uses cursor for pagination', async () => {
    pushResponse([]);
    await persistence.getMessages('t1', '01CURSOR');
    const sql = getLastSql();
    expect(sql).toContain("id > '01CURSOR'");
  });
});

// ─── ULID ordering ───────────────────────────────────────────────────

describe('ULID ordering', () => {
  test('sequential sendMessage calls produce ascending ULIDs', async () => {
    pushResponse();
    const msg1 = await persistence.sendMessage({
      threadId: 't1', authorId: 'a1', text: 'first',
    });
    pushResponse();
    const msg2 = await persistence.sendMessage({
      threadId: 't1', authorId: 'a1', text: 'second',
    });
    expect(msg1.id < msg2.id).toBe(true);
  });
});

// ─── Delivery tracking ──────────────────────────────────────────────

describe('trackDelivery', () => {
  test('inserts delivery record with upsert', async () => {
    pushResponse();
    await persistence.trackDelivery('msg1', 'agent:BAPert', 'delivered');
    const sql = getLastSql();
    expect(sql).toContain('acp_delivery');
    expect(sql).toContain('ON CONFLICT');
    expect(sql).toContain("'delivered'");
  });
});

describe('getDelivery', () => {
  test('returns null when not found', async () => {
    pushResponse([]);
    const result = await persistence.getDelivery('msg1', 'agent:BAPert');
    expect(result).toBeNull();
  });

  test('returns delivery record when found', async () => {
    pushResponse([{
      message_id: 'msg1', participant_id: 'agent:BAPert', status: 'delivered',
      created_at: '2026-01-01T00:00:00Z', delivered_at: '2026-01-01T00:00:01Z',
      read_at: null, retry_count: 0,
    }]);
    const result = await persistence.getDelivery('msg1', 'agent:BAPert');
    expect(result).not.toBeNull();
    expect(result!.status).toBe('delivered');
    expect(result!.retryCount).toBe(0);
  });
});

// ─── Reactions ──────────────────────────────────────────────────────

describe('addReaction', () => {
  test('inserts reaction with ON CONFLICT DO NOTHING', async () => {
    pushResponse();
    await persistence.addReaction('msg1', 'agent:BAPert', '👍');
    const sql = getLastSql();
    expect(sql).toContain('acp_reactions');
    expect(sql).toContain('ON CONFLICT');
    expect(sql).toContain('DO NOTHING');
  });
});

describe('getReactions', () => {
  test('returns reactions for message', async () => {
    pushResponse([
      { message_id: 'msg1', participant_id: 'agent:BAPert', emoji: '👍', created_at: '2026-01-01T00:00:00Z' },
    ]);
    const reactions = await persistence.getReactions('msg1');
    expect(reactions).toHaveLength(1);
    expect(reactions[0].emoji).toBe('👍');
  });
});

// ─── Attachments ────────────────────────────────────────────────────

describe('createAttachment', () => {
  test('creates attachment with ULID', async () => {
    pushResponse();
    const att = await persistence.createAttachment({
      messageId: 'msg1',
      type: 'file',
      name: 'spec.md',
      storageRef: '/specs/spec.md',
    });

    expect(att.id).toMatch(/^[0-9A-Z]{26}$/);
    expect(att.name).toBe('spec.md');
    expect(att.type).toBe('file');
  });
});

// ─── Unread counts ──────────────────────────────────────────────────

describe('getUnreadCounts', () => {
  test('returns unread counts per conversation', async () => {
    pushResponse([
      { conversation_id: 'conv1', unread: 5 },
      { conversation_id: 'conv2', unread: 2 },
    ]);
    const counts = await persistence.getUnreadCounts('agent:BAPert');
    expect(counts).toHaveLength(2);
    expect(counts[0]).toEqual({ conversationId: 'conv1', unread: 5 });
  });
});

// ─── Thread activity ────────────────────────────────────────────────

describe('getThreadActivity', () => {
  test('returns threads ordered by last activity', async () => {
    pushResponse([
      { id: 't1', conversation_id: 'c1', subject: 'Thread 1', status: 'open', created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z', last_activity: '2026-01-02T00:00:00Z' },
    ]);
    const activity = await persistence.getThreadActivity('agent:BAPert');
    expect(activity).toHaveLength(1);
    expect(activity[0].lastActivity).toBe('2026-01-02T00:00:00Z');
  });
});

// ─── Migration ──────────────────────────────────────────────────────

describe('runMigration', () => {
  test('splits and executes SQL statements', async () => {
    // Need to mock readFileSync for this test
    // The migration reads from a file, so we test via the query client mock
    // Push enough responses for each statement in schema.sql
    for (let i = 0; i < 15; i++) pushResponse();

    const path = new URL('../schema.sql', import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1');
    const result = await persistence.runMigration(path);

    expect(result.total).toBeGreaterThan(0);
    expect(result.succeeded).toBe(result.total);
    expect(result.failed).toHaveLength(0);
  });
});

// ─── Error handling ─────────────────────────────────────────────────

describe('VibeQueryClient error handling', () => {
  test('throws on VibeSQL error', async () => {
    mockResponses = [];
    (global as Record<string, unknown>).fetch = jest.fn(async () => ({
      json: async () => ({ success: false, error: { code: 'INVALID_SQL', message: 'bad query' } }),
      ok: true, status: 200,
    }));

    const client = new VibeQueryClient({ vibesqlDirectUrl: 'http://localhost:5173' });
    await expect(client.query('BAD SQL')).rejects.toThrow('bad query');
  });
});
