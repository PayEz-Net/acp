-- ACP Agent Chat schema (from spec v1.1, section 6.1)
-- All tables use acp_ prefix to avoid conflicts with existing tables.

-- Conversations
CREATE TABLE IF NOT EXISTS acp_conversations (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    type TEXT NOT NULL CHECK (type IN ('direct', 'group', 'channel')),
    state TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'resolved', 'archived')),
    project_id TEXT,
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Conversation participants
CREATE TABLE IF NOT EXISTS acp_conversation_participants (
    conversation_id TEXT NOT NULL REFERENCES acp_conversations(id),
    participant_id TEXT NOT NULL,
    participant_type TEXT NOT NULL CHECK (participant_type IN ('agent', 'human', 'system')),
    display_name TEXT NOT NULL,
    joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    left_at TIMESTAMPTZ,
    PRIMARY KEY (conversation_id, participant_id)
);

-- Threads
CREATE TABLE IF NOT EXISTS acp_threads (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES acp_conversations(id),
    subject TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Thread subscriptions (persistent, also cached in Redis)
CREATE TABLE IF NOT EXISTS acp_thread_subscriptions (
    thread_id TEXT NOT NULL REFERENCES acp_threads(id),
    participant_id TEXT NOT NULL,
    level TEXT NOT NULL DEFAULT 'mention-only' CHECK (level IN ('subscribed', 'mention-only', 'muted')),
    PRIMARY KEY (thread_id, participant_id)
);

-- Messages
CREATE TABLE IF NOT EXISTS acp_messages (
    id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL REFERENCES acp_threads(id),
    author_id TEXT NOT NULL,
    text TEXT NOT NULL,
    formatted TEXT,
    raw JSONB,
    parent_message_id TEXT REFERENCES acp_messages(id),
    dedupe_key TEXT UNIQUE,
    flags TEXT[] DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deleted_at TIMESTAMPTZ
);

-- Attachments
CREATE TABLE IF NOT EXISTS acp_attachments (
    id TEXT PRIMARY KEY,
    message_id TEXT NOT NULL REFERENCES acp_messages(id),
    type TEXT NOT NULL CHECK (type IN ('file', 'image', 'code', 'spec', 'artifact')),
    name TEXT NOT NULL,
    mime_type TEXT,
    size_bytes BIGINT,
    storage_ref TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Reactions
CREATE TABLE IF NOT EXISTS acp_reactions (
    message_id TEXT NOT NULL REFERENCES acp_messages(id),
    participant_id TEXT NOT NULL,
    emoji TEXT NOT NULL CHECK (length(emoji) <= 32),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (message_id, participant_id, emoji)
);

-- Delivery tracking
CREATE TABLE IF NOT EXISTS acp_delivery (
    message_id TEXT NOT NULL REFERENCES acp_messages(id),
    participant_id TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending', 'delivered', 'read', 'undeliverable')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    delivered_at TIMESTAMPTZ,
    read_at TIMESTAMPTZ,
    retry_count INT NOT NULL DEFAULT 0,
    PRIMARY KEY (message_id, participant_id)
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_messages_thread_id ON acp_messages(thread_id, created_at);
CREATE INDEX IF NOT EXISTS idx_messages_author ON acp_messages(author_id, created_at);
CREATE INDEX IF NOT EXISTS idx_messages_dedupe ON acp_messages(dedupe_key) WHERE dedupe_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_delivery_pending ON acp_delivery(participant_id, status) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_delivery_retention ON acp_delivery(read_at) WHERE status = 'read';
CREATE INDEX IF NOT EXISTS idx_threads_conversation ON acp_threads(conversation_id);
CREATE INDEX IF NOT EXISTS idx_participants_conv ON acp_conversation_participants(participant_id);
