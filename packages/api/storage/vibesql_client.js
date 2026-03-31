import { config as defaultConfig } from '../config.js';

function escapeSql(value) {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return 'NULL';
    return String(value);
  }
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  return '\'' + String(value).replace(/'/g, '\'\'') + '\'';
}

function escapeJsonb(obj) {
  return '\'' + JSON.stringify(obj).replace(/'/g, '\'\'') + '\'::jsonb';
}

function toSnake(str) {
  return str.replace(/[A-Z]/g, (c) => '_' + c.toLowerCase());
}

function toCamel(str) {
  return str.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
}

// JSONB fields that should be parsed from string to array/object
const JSONB_FIELDS = new Set([
  'keywords', 'needs', 'offers', 'members', 'filesChanged',
  'domainTags', 'typicalOffers', 'typicalNeeds', 'recentKeywords',
  'customFunctions', 'preferences', 'memory',
  'connectionInfo', 'capabilities',
  'expertiseJson', 'profileSnapshot', 'configJson'
]);

function rowToCamel(row) {
  const out = {};
  for (const [k, v] of Object.entries(row)) {
    const camelKey = toCamel(k);
    // Parse JSONB string fields back to arrays/objects
    if (JSONB_FIELDS.has(camelKey) && typeof v === 'string') {
      try {
        out[camelKey] = JSON.parse(v);
      } catch {
        out[camelKey] = v; // Keep original if parse fails
      }
    } else {
      out[camelKey] = v;
    }
  }
  return out;
}

const INIT_SQL = `
CREATE TABLE IF NOT EXISTS agent_sessions (
  id SERIAL PRIMARY KEY,
  session_id TEXT NOT NULL UNIQUE,
  agent_name TEXT NOT NULL UNIQUE,
  character TEXT,
  custom_functions JSONB DEFAULT '{}',
  preferences JSONB DEFAULT '{}',
  memory JSONB DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  version INTEGER DEFAULT 1
);

CREATE TABLE IF NOT EXISTS agent_signals (
  id SERIAL PRIMARY KEY,
  agent_id TEXT NOT NULL,
  agent_name TEXT NOT NULL,
  zone TEXT DEFAULT 'entrance',
  working_on TEXT,
  keywords JSONB DEFAULT '[]',
  needs JSONB DEFAULT '[]',
  offers JSONB DEFAULT '[]',
  position_x REAL DEFAULT 50,
  position_y REAL DEFAULT 50,
  status TEXT DEFAULT 'idle',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(agent_id)
);

CREATE TABLE IF NOT EXISTS agent_relevance (
  id SERIAL PRIMARY KEY,
  observer_agent TEXT NOT NULL,
  subject_agent TEXT NOT NULL,
  domain_tags JSONB DEFAULT '[]',
  typical_offers JSONB DEFAULT '[]',
  typical_needs JSONB DEFAULT '[]',
  recent_keywords JSONB DEFAULT '[]',
  last_broadcast_ts TEXT,
  total_mingles INTEGER DEFAULT 0,
  successful_mingles INTEGER DEFAULT 0,
  last_mingle_ts TEXT,
  last_mingle_outcome TEXT,
  base_relevance REAL DEFAULT 0,
  recent_relevance REAL DEFAULT 0,
  interaction_score REAL DEFAULT 0.5,
  combined_score REAL DEFAULT 0,
  UNIQUE(observer_agent, subject_agent)
);

CREATE TABLE IF NOT EXISTS mingle_sessions (
  id SERIAL PRIMARY KEY,
  mingle_id TEXT NOT NULL UNIQUE,
  agent_a TEXT NOT NULL,
  agent_b TEXT NOT NULL,
  interaction_type TEXT DEFAULT 'chit_chat',
  topic TEXT,
  outcome TEXT DEFAULT 'pending',
  started_at TEXT NOT NULL,
  ended_at TEXT
);

CREATE TABLE IF NOT EXISTS messages (
  id SERIAL PRIMARY KEY,
  message_type TEXT NOT NULL,
  channel TEXT,
  cluster_id TEXT,
  from_agent TEXT NOT NULL,
  to_agent TEXT,
  subject TEXT,
  body TEXT NOT NULL,
  priority TEXT DEFAULT 'normal',
  keywords JSONB DEFAULT '[]',
  is_read BOOLEAN DEFAULT FALSE,
  is_archived BOOLEAN DEFAULT FALSE,
  created_at TEXT NOT NULL,
  read_at TEXT
);

CREATE TABLE IF NOT EXISTS chat_clusters (
  id SERIAL PRIMARY KEY,
  cluster_id TEXT NOT NULL UNIQUE,
  topic TEXT,
  members JSONB DEFAULT '[]',
  status TEXT DEFAULT 'active',
  zone TEXT DEFAULT 'bar',
  formed_at TEXT NOT NULL,
  dissolved_at TEXT
);

CREATE TABLE IF NOT EXISTS kanban_tasks (
  id SERIAL PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT,
  status TEXT DEFAULT 'backlog',
  priority TEXT DEFAULT 'medium',
  assigned_to TEXT,
  created_by TEXT,
  spec_path TEXT,
  milestone TEXT,
  files_changed JSONB DEFAULT '[]',
  blockers TEXT,
  review_notes TEXT,
  reviewed_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT,
  completed_at TEXT
);

CREATE TABLE IF NOT EXISTS autonomy_state (
  id SERIAL PRIMARY KEY,
  enabled BOOLEAN DEFAULT FALSE,
  started_at TEXT,
  stop_condition TEXT DEFAULT 'milestone',
  current_milestone TEXT,
  max_runtime_hours INTEGER DEFAULT 4,
  escalation_sensitivity INTEGER DEFAULT 2,
  notify_webhook TEXT,
  stopped_at TEXT,
  stop_reason TEXT
);

CREATE TABLE IF NOT EXISTS standup_entries (
  id SERIAL PRIMARY KEY,
  agent_name TEXT NOT NULL,
  entry_type TEXT NOT NULL,
  summary TEXT NOT NULL,
  task_id INTEGER,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS escalation_log (
  id SERIAL PRIMARY KEY,
  sensitivity_level INTEGER NOT NULL,
  trigger_type TEXT NOT NULL,
  summary TEXT NOT NULL,
  shutdown_mode TEXT DEFAULT 'soft',
  resolved BOOLEAN DEFAULT FALSE,
  created_at TEXT NOT NULL,
  resolved_at TEXT
);

CREATE TABLE IF NOT EXISTS acp_runtime_registry (
  agent_id TEXT PRIMARY KEY,
  runtime TEXT NOT NULL,
  adapter TEXT NOT NULL,
  connection_info JSONB NOT NULL DEFAULT '{}',
  capabilities JSONB NOT NULL DEFAULT '{}',
  registered_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_heartbeat TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS agents (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  display_name TEXT,
  role TEXT,
  model TEXT,
  expertise_json JSONB DEFAULT '{}',
  agent_type VARCHAR(20) DEFAULT 'team',
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS agent_contracts (
  id SERIAL PRIMARY KEY,
  contractor_agent_id INTEGER NOT NULL,
  hired_by_agent_id INTEGER NOT NULL,
  contract_subject TEXT NOT NULL,
  contract_message_id INTEGER,
  status VARCHAR(20) NOT NULL DEFAULT 'active',
  profile_source TEXT,
  profile_snapshot JSONB,
  timeout_hours INTEGER DEFAULT 72,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_agents_name ON agents(name);

CREATE INDEX IF NOT EXISTS idx_agents_type ON agents(agent_type);

CREATE INDEX IF NOT EXISTS idx_contracts_contractor ON agent_contracts(contractor_agent_id);

CREATE INDEX IF NOT EXISTS idx_contracts_status ON agent_contracts(status) WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_contracts_hired_by ON agent_contracts(hired_by_agent_id) WHERE status = 'active';
`;

// Phase 2a migration: new columns on agent_contracts
const PHASE2A_MIGRATION = [
  `ALTER TABLE agent_contracts ADD COLUMN IF NOT EXISTS session_pid INTEGER`,
  `ALTER TABLE agent_contracts ADD COLUMN IF NOT EXISTS session_started_at TIMESTAMPTZ`,
  `ALTER TABLE agent_contracts ADD COLUMN IF NOT EXISTS session_ended_at TIMESTAMPTZ`,
  `ALTER TABLE agent_contracts ADD COLUMN IF NOT EXISTS exit_code INTEGER`,
  `ALTER TABLE agent_contracts ADD COLUMN IF NOT EXISTS cancel_reason TEXT`,
  // Update CHECK constraint to allow 'queued' and 'cancelled' statuses
  `ALTER TABLE agent_contracts DROP CONSTRAINT IF EXISTS agent_contracts_status_check`,
  `ALTER TABLE agent_contracts ADD CONSTRAINT agent_contracts_status_check
     CHECK (status IN ('active', 'queued', 'completed', 'cancelled', 'expired'))`,
];

// Projects migration: new tables + FKs
const PROJECTS_MIGRATION = [
  // Projects table
  `CREATE TABLE IF NOT EXISTS projects (
     id SERIAL PRIMARY KEY,
     name VARCHAR(200) NOT NULL UNIQUE,
     description TEXT,
     status VARCHAR(20) NOT NULL DEFAULT 'active'
       CHECK (status IN ('active', 'archived', 'completed')),
     created_at TIMESTAMPTZ DEFAULT NOW(),
     updated_at TIMESTAMPTZ DEFAULT NOW()
   )`,
  `CREATE INDEX IF NOT EXISTS idx_projects_status ON projects(status)`,
  // App config table
  `CREATE TABLE IF NOT EXISTS app_config (
     key VARCHAR(100) PRIMARY KEY,
     value TEXT NOT NULL,
     updated_at TIMESTAMPTZ DEFAULT NOW()
   )`,
  // FKs on existing tables
  `ALTER TABLE kanban_tasks ADD COLUMN IF NOT EXISTS project_id INTEGER`,
  `ALTER TABLE agent_contracts ADD COLUMN IF NOT EXISTS project_id INTEGER`,
  `ALTER TABLE standup_entries ADD COLUMN IF NOT EXISTS project_id INTEGER`,
  // Indexes (CREATE INDEX IF NOT EXISTS is safe)
  `CREATE INDEX IF NOT EXISTS idx_kanban_project ON kanban_tasks(project_id)`,
  `CREATE INDEX IF NOT EXISTS idx_contracts_project ON agent_contracts(project_id)`,
  `CREATE INDEX IF NOT EXISTS idx_standups_project ON standup_entries(project_id)`,
  // Seed Default project if none exists
  `INSERT INTO projects (name, description) VALUES ('Default', 'Default project for existing data')
   ON CONFLICT (name) DO NOTHING`,
  // Seed active_project_id config if not set
  `INSERT INTO app_config (key, value)
   VALUES ('active_project_id', (SELECT id::TEXT FROM projects WHERE name = 'Default' LIMIT 1))
   ON CONFLICT (key) DO NOTHING`,
  // Backfill: assign existing rows to Default project
  `UPDATE kanban_tasks SET project_id = (SELECT id FROM projects WHERE name = 'Default') WHERE project_id IS NULL`,
  `UPDATE agent_contracts SET project_id = (SELECT id FROM projects WHERE name = 'Default') WHERE project_id IS NULL`,
  `UPDATE standup_entries SET project_id = (SELECT id FROM projects WHERE name = 'Default') WHERE project_id IS NULL`,
];

// Unattended mode migration: new columns on autonomy_state
const UNATTENDED_MIGRATION = [
  `ALTER TABLE autonomy_state ADD COLUMN IF NOT EXISTS unattended_mode BOOLEAN DEFAULT FALSE`,
  `ALTER TABLE autonomy_state ADD COLUMN IF NOT EXISTS escalation_level INTEGER DEFAULT 2`,
];

// Contractor Lifecycle v2 migration: mailbox_slot, conversation_id, promoted status
const CONTRACTOR_V2_MIGRATION = [
  `ALTER TABLE agent_contracts ADD COLUMN IF NOT EXISTS mailbox_slot VARCHAR(20)`,
  `ALTER TABLE agent_contracts ADD COLUMN IF NOT EXISTS conversation_id TEXT`,
  `ALTER TABLE agent_contracts DROP CONSTRAINT IF EXISTS agent_contracts_status_check`,
  `ALTER TABLE agent_contracts ADD CONSTRAINT agent_contracts_status_check
     CHECK (status IN ('active', 'queued', 'completed', 'cancelled', 'expired', 'promoted'))`,
];

// Agent startup config migration: startup_order + deleted_at columns
const STARTUP_CONFIG_MIGRATION = [
  `ALTER TABLE agents ADD COLUMN IF NOT EXISTS startup_order INTEGER DEFAULT 0`,
  `ALTER TABLE agents ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ`,
];

// Chat schema migration — creates acp_* tables (from chat/schema.sql)
// Must be ordered: conversations → participants → threads → subscriptions → messages → attachments/reactions/delivery
const CHAT_SCHEMA_MIGRATION = [
  `CREATE TABLE IF NOT EXISTS acp_conversations (
     id TEXT PRIMARY KEY,
     title TEXT NOT NULL,
     type TEXT NOT NULL CHECK (type IN ('direct', 'group', 'channel')),
     state TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'resolved', 'archived')),
     project_id TEXT,
     metadata JSONB DEFAULT '{}',
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
   )`,
  `CREATE TABLE IF NOT EXISTS acp_conversation_participants (
     conversation_id TEXT NOT NULL REFERENCES acp_conversations(id),
     participant_id TEXT NOT NULL,
     participant_type TEXT NOT NULL CHECK (participant_type IN ('agent', 'human', 'system')),
     display_name TEXT NOT NULL,
     joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     left_at TIMESTAMPTZ,
     PRIMARY KEY (conversation_id, participant_id)
   )`,
  `CREATE TABLE IF NOT EXISTS acp_threads (
     id TEXT PRIMARY KEY,
     conversation_id TEXT NOT NULL REFERENCES acp_conversations(id),
     subject TEXT NOT NULL DEFAULT '',
     status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
   )`,
  `CREATE TABLE IF NOT EXISTS acp_thread_subscriptions (
     thread_id TEXT NOT NULL REFERENCES acp_threads(id),
     participant_id TEXT NOT NULL,
     level TEXT NOT NULL DEFAULT 'mention-only' CHECK (level IN ('subscribed', 'mention-only', 'muted')),
     PRIMARY KEY (thread_id, participant_id)
   )`,
  `CREATE TABLE IF NOT EXISTS acp_messages (
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
   )`,
  `CREATE TABLE IF NOT EXISTS acp_attachments (
     id TEXT PRIMARY KEY,
     message_id TEXT NOT NULL REFERENCES acp_messages(id),
     type TEXT NOT NULL CHECK (type IN ('file', 'image', 'code', 'spec', 'artifact')),
     name TEXT NOT NULL,
     mime_type TEXT,
     size_bytes BIGINT,
     storage_ref TEXT NOT NULL,
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
   )`,
  `CREATE TABLE IF NOT EXISTS acp_reactions (
     message_id TEXT NOT NULL REFERENCES acp_messages(id),
     participant_id TEXT NOT NULL,
     emoji TEXT NOT NULL CHECK (length(emoji) <= 32),
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     PRIMARY KEY (message_id, participant_id, emoji)
   )`,
  `CREATE TABLE IF NOT EXISTS acp_delivery (
     message_id TEXT NOT NULL REFERENCES acp_messages(id),
     participant_id TEXT NOT NULL,
     status TEXT NOT NULL CHECK (status IN ('pending', 'delivered', 'read', 'undeliverable')),
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     delivered_at TIMESTAMPTZ,
     read_at TIMESTAMPTZ,
     retry_count INT NOT NULL DEFAULT 0,
     PRIMARY KEY (message_id, participant_id)
   )`,
  `CREATE INDEX IF NOT EXISTS idx_messages_thread_id ON acp_messages(thread_id, created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_messages_author ON acp_messages(author_id, created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_messages_dedupe ON acp_messages(dedupe_key) WHERE dedupe_key IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS idx_delivery_pending ON acp_delivery(participant_id, status) WHERE status = 'pending'`,
  `CREATE INDEX IF NOT EXISTS idx_threads_conversation ON acp_threads(conversation_id)`,
  `CREATE INDEX IF NOT EXISTS idx_participants_conv ON acp_conversation_participants(participant_id)`,
];

export class VibeSqlClient {
  constructor(cfg) {
    this._config = cfg || defaultConfig;
  }

  async _query(sql) {
    const url = `${this._config.vibesqlUrl}/v1/query`;
    const headers = { 'Content-Type': 'application/json' };
    if (this._config.vibesqlContainerSecret) {
      headers['Authorization'] = `Secret ${this._config.vibesqlContainerSecret}`;
    }
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ sql }),
    });
    const data = await res.json();
    if (!data.success) {
      const err = new Error(data.error?.message || 'VibeSQL query failed');
      err.code = data.error?.code || 'INTERNAL_ERROR';
      err.detail = data.error?.detail;
      err.statusCode = res.status;
      throw err;
    }
    // Normalize response: VibeSQL Server returns rows in 'data' field, not 'rows'
    if (data.rows === undefined) {
      data.rows = data.data || [];
    }
    return data;
  }

  async init() {
    const statements = INIT_SQL.split(';')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    for (const stmt of statements) {
      await this._query(stmt);
    }
    // Phase 2a migration
    for (const stmt of PHASE2A_MIGRATION) {
      try { await this._query(stmt); } catch (e) {
        console.warn('[VibeSqlClient] Phase2a migration step skipped:', e.message || e);
      }
    }
    // Projects migration
    for (const stmt of PROJECTS_MIGRATION) {
      try { await this._query(stmt); } catch (e) {
        console.warn('[VibeSqlClient] Projects migration step failed:', e.message || e);
      }
    }
    // Unattended mode migration
    for (const stmt of UNATTENDED_MIGRATION) {
      try { await this._query(stmt); } catch (e) {
        console.warn('[VibeSqlClient] Unattended migration step skipped:', e.message || e);
      }
    }
    // Contractor Lifecycle v2 migration (mailbox_slot, conversation_id, promoted status)
    for (const stmt of CONTRACTOR_V2_MIGRATION) {
      try { await this._query(stmt); } catch (e) {
        console.warn('[VibeSqlClient] Contractor v2 migration step skipped:', e.message || e);
      }
    }
    // Agent startup config migration
    for (const stmt of STARTUP_CONFIG_MIGRATION) {
      try { await this._query(stmt); } catch (e) {
        console.warn('[VibeSqlClient] Startup config migration step skipped:', e.message || e);
      }
    }
    // Chat schema migration (acp_* tables)
    for (const stmt of CHAT_SCHEMA_MIGRATION) {
      try { await this._query(stmt); } catch (e) {
        console.warn('[VibeSqlClient] Chat schema migration step skipped:', e.message || e);
      }
    }
  }

  async getSession(agentName) {
    const result = await this._query(
      `SELECT * FROM agent_sessions WHERE agent_name = ${escapeSql(agentName)}`
    );
    if (result.rows.length === 0) return null;
    return this._sessionFromRow(result.rows[0]);
  }

  async saveSession(session) {
    const now = new Date().toISOString();
    await this._query(`INSERT INTO agent_sessions
      (session_id, agent_name, character, custom_functions, preferences, memory, created_at, updated_at, version)
      VALUES (
        ${escapeSql(session.sessionId)},
        ${escapeSql(session.agentName)},
        ${escapeSql(session.character || null)},
        ${escapeJsonb(session.customFunctions || {})},
        ${escapeJsonb(session.preferences || {})},
        ${escapeJsonb(session.memory || {})},
        ${escapeSql(session.createdAt || now)},
        ${escapeSql(now)},
        ${escapeSql(session.version || 1)}
      )
      ON CONFLICT (agent_name) DO UPDATE SET
        session_id = EXCLUDED.session_id,
        character = EXCLUDED.character,
        custom_functions = EXCLUDED.custom_functions,
        preferences = EXCLUDED.preferences,
        memory = EXCLUDED.memory,
        updated_at = EXCLUDED.updated_at,
        version = EXCLUDED.version`);
  }

  async deleteSession(agentName) {
    await this._query(
      `DELETE FROM agent_sessions WHERE agent_name = ${escapeSql(agentName)}`
    );
  }

  async listSessions() {
    const result = await this._query('SELECT * FROM agent_sessions ORDER BY agent_name');
    return result.rows.map((r) => this._sessionFromRow(r));
  }

  async upsertSignal(signal) {
    const now = new Date().toISOString();
    await this._query(`INSERT INTO agent_signals
      (agent_id, agent_name, zone, working_on, keywords, needs, offers, created_at, updated_at)
      VALUES (
        ${escapeSql(signal.agentId)},
        ${escapeSql(signal.agentName)},
        ${escapeSql(signal.zone || 'entrance')},
        ${escapeSql(signal.workingOn || null)},
        ${escapeJsonb(signal.keywords || [])},
        ${escapeJsonb(signal.needs || [])},
        ${escapeJsonb(signal.offers || [])},
        ${escapeSql(now)},
        ${escapeSql(now)}
      )
      ON CONFLICT (agent_id) DO UPDATE SET
        agent_name = EXCLUDED.agent_name,
        zone = EXCLUDED.zone,
        working_on = EXCLUDED.working_on,
        keywords = EXCLUDED.keywords,
        needs = EXCLUDED.needs,
        offers = EXCLUDED.offers,
        updated_at = EXCLUDED.updated_at`);
  }

  async getSignal(agentId) {
    const result = await this._query(
      `SELECT * FROM agent_signals WHERE agent_id = ${escapeSql(agentId)}`
    );
    if (result.rows.length === 0) return null;
    return rowToCamel(result.rows[0]);
  }

  async listSignals() {
    const result = await this._query('SELECT * FROM agent_signals ORDER BY agent_id');
    return result.rows.map(rowToCamel);
  }

  async upsertRelevance(rel) {
    await this._query(`INSERT INTO agent_relevance
      (observer_agent, subject_agent, domain_tags, typical_offers, typical_needs, recent_keywords, last_broadcast_ts, total_mingles, successful_mingles, last_mingle_ts, last_mingle_outcome, base_relevance, recent_relevance, interaction_score, combined_score)
      VALUES (
        ${escapeSql(rel.observerAgent)}, ${escapeSql(rel.subjectAgent)},
        ${escapeJsonb(rel.domainTags || [])}, ${escapeJsonb(rel.typicalOffers || [])},
        ${escapeJsonb(rel.typicalNeeds || [])}, ${escapeJsonb(rel.recentKeywords || [])},
        ${escapeSql(rel.lastBroadcastTs || null)}, ${escapeSql(rel.totalMingles || 0)},
        ${escapeSql(rel.successfulMingles || 0)}, ${escapeSql(rel.lastMingleTs || null)},
        ${escapeSql(rel.lastMingleOutcome || null)}, ${escapeSql(rel.baseRelevance || 0)},
        ${escapeSql(rel.recentRelevance || 0)}, ${escapeSql(rel.interactionScore ?? 0.5)},
        ${escapeSql(rel.combinedScore || 0)}
      )
      ON CONFLICT (observer_agent, subject_agent) DO UPDATE SET
        domain_tags = EXCLUDED.domain_tags,
        typical_offers = EXCLUDED.typical_offers,
        typical_needs = EXCLUDED.typical_needs,
        recent_keywords = EXCLUDED.recent_keywords,
        last_broadcast_ts = EXCLUDED.last_broadcast_ts,
        total_mingles = EXCLUDED.total_mingles,
        successful_mingles = EXCLUDED.successful_mingles,
        last_mingle_ts = EXCLUDED.last_mingle_ts,
        last_mingle_outcome = EXCLUDED.last_mingle_outcome,
        base_relevance = EXCLUDED.base_relevance,
        recent_relevance = EXCLUDED.recent_relevance,
        interaction_score = EXCLUDED.interaction_score,
        combined_score = EXCLUDED.combined_score`);
  }

  async getRelevance(observer, subject) {
    const result = await this._query(
      `SELECT * FROM agent_relevance WHERE observer_agent = ${escapeSql(observer)} AND subject_agent = ${escapeSql(subject)}`
    );
    if (result.rows.length === 0) return null;
    return rowToCamel(result.rows[0]);
  }

  async listRelevance(observer) {
    const result = await this._query(
      `SELECT * FROM agent_relevance WHERE observer_agent = ${escapeSql(observer)}`
    );
    return result.rows.map(rowToCamel);
  }

  async createMingle(mingle) {
    const now = new Date().toISOString();
    await this._query(`INSERT INTO mingle_sessions
      (mingle_id, agent_a, agent_b, interaction_type, topic, outcome, started_at)
      VALUES (
        ${escapeSql(mingle.mingleId)},
        ${escapeSql(mingle.agentA)},
        ${escapeSql(mingle.agentB)},
        ${escapeSql(mingle.interactionType || 'chit_chat')},
        ${escapeSql(mingle.topic || null)},
        ${escapeSql(mingle.outcome || 'pending')},
        ${escapeSql(mingle.startedAt || now)}
      )`);
  }

  async updateMingle(id, updates) {
    const sets = [];
    if (updates.outcome !== undefined) sets.push(`outcome = ${escapeSql(updates.outcome)}`);
    if (updates.endedAt !== undefined) sets.push(`ended_at = ${escapeSql(updates.endedAt)}`);
    if (sets.length === 0) return;
    await this._query(`UPDATE mingle_sessions SET ${sets.join(', ')} WHERE mingle_id = ${escapeSql(id)}`);
  }

  async listActiveMingles() {
    const result = await this._query(
      'SELECT * FROM mingle_sessions WHERE outcome = \'pending\' ORDER BY started_at'
    );
    return result.rows.map(rowToCamel);
  }

  async createMessage(msg) {
    const now = new Date().toISOString();
    const result = await this._query(`INSERT INTO messages
      (message_type, channel, cluster_id, from_agent, to_agent, subject, body, priority, keywords, created_at)
      VALUES (
        ${escapeSql(msg.messageType)},
        ${escapeSql(msg.channel || null)},
        ${escapeSql(msg.clusterId || null)},
        ${escapeSql(msg.fromAgent)},
        ${escapeSql(msg.toAgent || null)},
        ${escapeSql(msg.subject || null)},
        ${escapeSql(msg.body)},
        ${escapeSql(msg.priority || 'normal')},
        ${escapeJsonb(msg.keywords || [])},
        ${escapeSql(msg.createdAt || now)}
      ) RETURNING id`);
    if (!result.rows || result.rows.length === 0) {
      throw new Error('createMessage: INSERT returned no rows');
    }
    return result.rows[0].id;
  }

  async getMessageById(id) {
    const result = await this._query(
      `SELECT * FROM messages WHERE id = ${escapeSql(id)}`
    );
    if (result.rows.length === 0) return null;
    return rowToCamel(result.rows[0]);
  }

  async getMessages(filter = {}) {
    const conditions = ['1=1'];
    if (filter.messageType) conditions.push(`message_type = ${escapeSql(filter.messageType)}`);
    if (filter.toAgent) conditions.push(`to_agent = ${escapeSql(filter.toAgent)}`);
    if (filter.fromAgent) conditions.push(`from_agent = ${escapeSql(filter.fromAgent)}`);
    if (filter.channel) conditions.push(`channel = ${escapeSql(filter.channel)}`);
    if (filter.clusterId) conditions.push(`cluster_id = ${escapeSql(filter.clusterId)}`);
    if (filter.isRead !== undefined) conditions.push(`is_read = ${escapeSql(filter.isRead)}`);
    if (filter.isArchived !== undefined) conditions.push(`is_archived = ${escapeSql(filter.isArchived)}`);
    const result = await this._query(
      `SELECT * FROM messages WHERE ${conditions.join(' AND ')} ORDER BY created_at DESC`
    );
    return result.rows.map(rowToCamel);
  }

  async markRead(id) {
    const now = new Date().toISOString();
    await this._query(`UPDATE messages SET is_read = TRUE, read_at = ${escapeSql(now)} WHERE id = ${escapeSql(id)}`);
  }

  async archiveMessage(id) {
    await this._query(`UPDATE messages SET is_archived = TRUE WHERE id = ${escapeSql(id)}`);
  }

  async markAllRead(agentName) {
    const now = new Date().toISOString();
    await this._query(`UPDATE messages SET is_read = TRUE, read_at = ${escapeSql(now)} WHERE to_agent = ${escapeSql(agentName)} AND is_read = FALSE`);
  }

  async createCluster(cluster) {
    const now = new Date().toISOString();
    await this._query(`INSERT INTO chat_clusters
      (cluster_id, topic, members, status, zone, formed_at)
      VALUES (
        ${escapeSql(cluster.clusterId)},
        ${escapeSql(cluster.topic || null)},
        ${escapeJsonb(cluster.members || [])},
        ${escapeSql(cluster.status || 'active')},
        ${escapeSql(cluster.zone || 'bar')},
        ${escapeSql(cluster.formedAt || now)}
      )`);
  }

  async getCluster(clusterId) {
    const result = await this._query(
      `SELECT * FROM chat_clusters WHERE cluster_id = ${escapeSql(clusterId)}`
    );
    if (result.rows.length === 0) return null;
    return rowToCamel(result.rows[0]);
  }

  async updateCluster(id, updates) {
    const sets = [];
    if (updates.members !== undefined) sets.push(`members = ${escapeJsonb(updates.members)}`);
    if (updates.status !== undefined) sets.push(`status = ${escapeSql(updates.status)}`);
    if (updates.dissolvedAt !== undefined) sets.push(`dissolved_at = ${escapeSql(updates.dissolvedAt)}`);
    if (sets.length === 0) return;
    await this._query(`UPDATE chat_clusters SET ${sets.join(', ')} WHERE cluster_id = ${escapeSql(id)}`);
  }

  async createTask(task) {
    const now = new Date().toISOString();
    const projectId = task.projectId || (await this.getActiveProjectId());
    const result = await this._query(`INSERT INTO kanban_tasks
      (title, description, status, priority, assigned_to, created_by, spec_path, milestone, files_changed, blockers, created_at, project_id)
      VALUES (
        ${escapeSql(task.title)},
        ${escapeSql(task.description || null)},
        ${escapeSql(task.status || 'backlog')},
        ${escapeSql(task.priority || 'medium')},
        ${escapeSql(task.assignedTo || null)},
        ${escapeSql(task.createdBy || null)},
        ${escapeSql(task.specPath || null)},
        ${escapeSql(task.milestone || null)},
        ${escapeJsonb(task.filesChanged || [])},
        ${escapeSql(task.blockers || null)},
        ${escapeSql(task.createdAt || now)},
        ${escapeSql(projectId)}
      ) RETURNING id`);
    if (!result.rows || result.rows.length === 0) {
      throw new Error('createTask: INSERT returned no rows');
    }
    return result.rows[0].id;
  }

  async getTask(id) {
    const result = await this._query(`SELECT * FROM kanban_tasks WHERE id = ${escapeSql(id)}`);
    if (result.rows.length === 0) return null;
    return rowToCamel(result.rows[0]);
  }

  async listTasks(filter = {}) {
    const conditions = ['1=1'];
    // Project scoping: filter by active project
    const projectId = filter.projectId || (await this.getActiveProjectId());
    if (projectId) conditions.push(`project_id = ${escapeSql(projectId)}`);
    if (filter.status) {
      const statuses = Array.isArray(filter.status) ? filter.status : [filter.status];
      conditions.push(`status IN (${statuses.map(escapeSql).join(', ')})`);
    }
    if (filter.assignedTo) conditions.push(`assigned_to = ${escapeSql(filter.assignedTo)}`);
    if (filter.milestone) conditions.push(`milestone = ${escapeSql(filter.milestone)}`);
    if (filter.priority) conditions.push(`priority = ${escapeSql(filter.priority)}`);
    const result = await this._query(
      `SELECT * FROM kanban_tasks WHERE ${conditions.join(' AND ')} ORDER BY id`
    );
    return result.rows.map(rowToCamel);
  }

  async updateTask(id, updates) {
    const sets = [];
    const now = new Date().toISOString();
    if (updates.status !== undefined) sets.push(`status = ${escapeSql(updates.status)}`);
    if (updates.assignedTo !== undefined) sets.push(`assigned_to = ${escapeSql(updates.assignedTo)}`);
    if (updates.reviewNotes !== undefined) sets.push(`review_notes = ${escapeSql(updates.reviewNotes)}`);
    if (updates.reviewedBy !== undefined) sets.push(`reviewed_by = ${escapeSql(updates.reviewedBy)}`);
    if (updates.filesChanged !== undefined) sets.push(`files_changed = ${escapeJsonb(updates.filesChanged)}`);
    if (updates.blockers !== undefined) sets.push(`blockers = ${escapeSql(updates.blockers)}`);
    if (updates.completedAt !== undefined) sets.push(`completed_at = ${escapeSql(updates.completedAt)}`);
    sets.push(`updated_at = ${escapeSql(now)}`);
    await this._query(`UPDATE kanban_tasks SET ${sets.join(', ')} WHERE id = ${escapeSql(id)}`);
  }

  async deleteTask(id) {
    await this._query(`DELETE FROM kanban_tasks WHERE id = ${escapeSql(id)}`);
  }

  async getAutonomyState() {
    const result = await this._query('SELECT * FROM autonomy_state ORDER BY id DESC LIMIT 1');
    if (result.rows.length === 0) return null;
    return rowToCamel(result.rows[0]);
  }

  async updateAutonomyState(updates) {
    const existing = await this.getAutonomyState();
    if (existing) {
      const sets = [];
      for (const [key, val] of Object.entries(updates)) {
        const col = toSnake(key);
        if (typeof val === 'object' && val !== null) {
          sets.push(`${col} = ${escapeJsonb(val)}`);
        } else {
          sets.push(`${col} = ${escapeSql(val)}`);
        }
      }
      if (sets.length > 0) {
        await this._query(`UPDATE autonomy_state SET ${sets.join(', ')} WHERE id = ${escapeSql(existing.id)}`);
      }
    } else {
      const cols = Object.keys(updates).map(toSnake);
      const vals = Object.values(updates).map((v) =>
        typeof v === 'object' && v !== null ? escapeJsonb(v) : escapeSql(v)
      );
      await this._query(`INSERT INTO autonomy_state (${cols.join(', ')}) VALUES (${vals.join(', ')})`);
    }
  }

  async createStandupEntry(entry) {
    const now = new Date().toISOString();
    const projectId = entry.projectId || (await this.getActiveProjectId());
    await this._query(`INSERT INTO standup_entries
      (agent_name, entry_type, summary, task_id, created_at, project_id)
      VALUES (
        ${escapeSql(entry.agentName)},
        ${escapeSql(entry.entryType)},
        ${escapeSql(entry.summary)},
        ${escapeSql(entry.taskId || null)},
        ${escapeSql(entry.createdAt || now)},
        ${escapeSql(projectId)}
      )`);
  }

  async listStandupEntries(filter = {}) {
    const conditions = ['1=1'];
    // Project scoping
    const projectId = filter.projectId || (await this.getActiveProjectId());
    if (projectId) conditions.push(`project_id = ${escapeSql(projectId)}`);
    if (filter.agentName) conditions.push(`agent_name = ${escapeSql(filter.agentName)}`);
    if (filter.entryType) conditions.push(`entry_type = ${escapeSql(filter.entryType)}`);
    const result = await this._query(
      `SELECT * FROM standup_entries WHERE ${conditions.join(' AND ')} ORDER BY created_at DESC`
    );
    return result.rows.map(rowToCamel);
  }

  async createEscalation(esc) {
    const now = new Date().toISOString();
    await this._query(`INSERT INTO escalation_log
      (sensitivity_level, trigger_type, summary, shutdown_mode, created_at)
      VALUES (
        ${escapeSql(esc.sensitivityLevel)},
        ${escapeSql(esc.triggerType)},
        ${escapeSql(esc.summary)},
        ${escapeSql(esc.shutdownMode || 'soft')},
        ${escapeSql(esc.createdAt || now)}
      )`);
  }

  async listEscalations(filter = {}) {
    const conditions = ['1=1'];
    if (filter.resolved !== undefined) conditions.push(`resolved = ${escapeSql(filter.resolved)}`);
    const result = await this._query(
      `SELECT * FROM escalation_log WHERE ${conditions.join(' AND ')} ORDER BY created_at DESC`
    );
    return result.rows.map(rowToCamel);
  }

  // --- Runtime Registry ---

  async registerAgent(reg) {
    await this._query(`INSERT INTO acp_runtime_registry
      (agent_id, runtime, adapter, connection_info, capabilities)
      VALUES (
        ${escapeSql(reg.agentId)},
        ${escapeSql(reg.runtime)},
        ${escapeSql(reg.adapter)},
        ${escapeJsonb(reg.connectionInfo || {})},
        ${escapeJsonb(reg.capabilities || {})}
      )
      ON CONFLICT (agent_id) DO UPDATE SET
        runtime = EXCLUDED.runtime,
        adapter = EXCLUDED.adapter,
        connection_info = EXCLUDED.connection_info,
        capabilities = EXCLUDED.capabilities,
        last_heartbeat = NOW()`);
  }

  async deregisterAgent(agentId) {
    await this._query(
      `DELETE FROM acp_runtime_registry WHERE agent_id = ${escapeSql(agentId)}`
    );
  }

  async getAgentRegistration(agentId) {
    const result = await this._query(
      `SELECT * FROM acp_runtime_registry WHERE agent_id = ${escapeSql(agentId)}`
    );
    if (result.rows.length === 0) return null;
    return rowToCamel(result.rows[0]);
  }

  async listRegistrations() {
    const result = await this._query('SELECT * FROM acp_runtime_registry ORDER BY registered_at');
    return result.rows.map(rowToCamel);
  }

  // --- Agents ---

  async getAgentByName(name) {
    const result = await this._query(
      `SELECT * FROM agents WHERE name = ${escapeSql(name)} AND deleted_at IS NULL`
    );
    if (result.rows.length === 0) return null;
    return rowToCamel(result.rows[0]);
  }

  async getAgentById(id) {
    const result = await this._query(
      `SELECT * FROM agents WHERE id = ${escapeSql(id)} AND deleted_at IS NULL`
    );
    if (result.rows.length === 0) return null;
    return rowToCamel(result.rows[0]);
  }

  async upsertAgent(agent) {
    const result = await this._query(
      `INSERT INTO agents (name, display_name, role, model, expertise_json, agent_type, is_active)
       VALUES (
         ${escapeSql(agent.name)},
         ${escapeSql(agent.displayName || agent.name)},
         ${escapeSql(agent.role || null)},
         ${escapeSql(agent.model || null)},
         ${escapeJsonb(agent.expertiseJson || {})},
         ${escapeSql(agent.agentType || 'team')},
         ${escapeSql(agent.isActive !== false)}
       )
       ON CONFLICT (name) DO NOTHING
       RETURNING id, name, agent_type`
    );
    if (result.rows.length > 0) return rowToCamel(result.rows[0]);
    // Already existed — fetch it
    return this.getAgentByName(agent.name);
  }

  async updateAgent(id, updates) {
    const sets = [];
    if (updates.displayName !== undefined) sets.push(`display_name = ${escapeSql(updates.displayName)}`);
    if (updates.role !== undefined) sets.push(`role = ${escapeSql(updates.role)}`);
    if (updates.model !== undefined) sets.push(`model = ${escapeSql(updates.model)}`);
    if (updates.expertiseJson !== undefined) sets.push(`expertise_json = ${escapeJsonb(updates.expertiseJson)}`);
    if (updates.agentType !== undefined) sets.push(`agent_type = ${escapeSql(updates.agentType)}`);
    if (updates.isActive !== undefined) sets.push(`is_active = ${escapeSql(updates.isActive)}`);
    if (updates.startupOrder !== undefined) sets.push(`startup_order = ${escapeSql(updates.startupOrder)}`);
    sets.push(`updated_at = NOW()`);
    const result = await this._query(
      `UPDATE agents SET ${sets.join(', ')} WHERE id = ${escapeSql(id)} RETURNING *`
    );
    if (result.rows.length === 0) return null;
    return rowToCamel(result.rows[0]);
  }

  async listActiveAgents() {
    const result = await this._query(
      `SELECT * FROM agents WHERE is_active = true AND deleted_at IS NULL ORDER BY startup_order ASC, name ASC`
    );
    return result.rows.map(rowToCamel);
  }

  async softDeleteAgent(id) {
    await this._query(
      `UPDATE agents SET is_active = false, deleted_at = NOW(), updated_at = NOW()
       WHERE id = ${escapeSql(id)}`
    );
  }

  async bulkUpdateStartupOrder(entries) {
    const updates = entries.map(entry =>
      `UPDATE agents SET startup_order = ${escapeSql(parseInt(entry.startup_order, 10))}, updated_at = NOW() WHERE id = ${escapeSql(parseInt(entry.agent_id, 10))};`
    ).join('\n');
    await this._query(`DO $$ BEGIN\n${updates}\nEND $$`);
  }

  async listAllAgents() {
    const result = await this._query(
      `SELECT * FROM agents WHERE deleted_at IS NULL ORDER BY startup_order ASC, name ASC`
    );
    return result.rows.map(rowToCamel);
  }

  async listAgentsByType(agentType) {
    const result = await this._query(
      `SELECT * FROM agents WHERE agent_type = ${escapeSql(agentType)} AND deleted_at IS NULL ORDER BY name`
    );
    return result.rows.map(rowToCamel);
  }

  // --- Agent Contracts ---

  async createContract(contract) {
    const projectId = contract.projectId || (await this.getActiveProjectId());
    const result = await this._query(
      `INSERT INTO agent_contracts
        (contractor_agent_id, hired_by_agent_id, contract_subject, contract_message_id, profile_source, profile_snapshot, timeout_hours, project_id, conversation_id)
       VALUES (
         ${escapeSql(contract.contractorAgentId)},
         ${escapeSql(contract.hiredByAgentId)},
         ${escapeSql(contract.contractSubject)},
         ${escapeSql(contract.contractMessageId || null)},
         ${escapeSql(contract.profileSource || null)},
         ${escapeJsonb(contract.profileSnapshot || null)},
         ${escapeSql(contract.timeoutHours ?? 72)},
         ${escapeSql(projectId)},
         ${escapeSql(contract.conversationId || null)}
       ) RETURNING *`
    );
    return result.rows.length > 0 ? rowToCamel(result.rows[0]) : null;
  }

  async getContract(id) {
    const result = await this._query(
      `SELECT * FROM agent_contracts WHERE id = ${escapeSql(id)}`
    );
    if (result.rows.length === 0) return null;
    return rowToCamel(result.rows[0]);
  }

  async listContracts(status = 'active', projectId = null) {
    const conditions = [];
    if (status !== 'all') conditions.push(`c.status = ${escapeSql(status)}`);
    // Project scoping
    const pid = projectId || (await this.getActiveProjectId());
    if (pid) conditions.push(`c.project_id = ${escapeSql(pid)}`);
    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const result = await this._query(
      `SELECT c.*, c.mailbox_slot, c.conversation_id,
              a.name AS contractor_name, a.display_name AS contractor_display_name,
              a.role AS contractor_role, a.model AS contractor_model, a.expertise_json AS contractor_expertise,
              h.name AS hired_by_name
       FROM agent_contracts c
       JOIN agents a ON a.id = c.contractor_agent_id
       JOIN agents h ON h.id = c.hired_by_agent_id
       ${whereClause}
       ORDER BY c.created_at DESC`
    );
    return result.rows.map(rowToCamel);
  }

  async countActiveContractsByHirer(hiredByAgentId) {
    const result = await this._query(
      `SELECT COUNT(*) AS count FROM agent_contracts
       WHERE hired_by_agent_id = ${escapeSql(hiredByAgentId)} AND status = 'active'`
    );
    return parseInt(result.rows[0]?.count || '0', 10);
  }

  async completeContract(contractId) {
    const now = new Date().toISOString();
    const result = await this._query(
      `UPDATE agent_contracts SET status = 'completed', completed_at = ${escapeSql(now)}
       WHERE id = ${escapeSql(contractId)} AND status IN ('active', 'queued')
       RETURNING *`
    );
    return result.rows.length > 0 ? rowToCamel(result.rows[0]) : null;
  }

  async expireContracts() {
    const result = await this._query(
      `UPDATE agent_contracts
       SET status = 'expired', completed_at = NOW()
       WHERE status = 'active'
         AND created_at + (timeout_hours || ' hours')::INTERVAL < NOW()
       RETURNING *`
    );
    return result.rows.map(rowToCamel);
  }

  async listDocuments() {
    const result = await this._query(
      `SELECT document_id, data FROM vibe.documents
       WHERE client_id = 8 AND collection = 'vibe_agents' AND table_name = 'agent_documents'
       ORDER BY (data->>'created_at') DESC`
    );
    return result.rows.map(r => {
      const d = typeof r.data === 'string' ? JSON.parse(r.data) : r.data;
      return {
        id: d.document_id || r.document_id,
        title: d.title || d.filename || 'Untitled',
        content_md: d.content_md || '',
        type: d.document_type || 'attachment',
        author_agent: d.created_by ? String(d.created_by) : undefined,
        version: d.version || 1,
        parent_document_id: d.parent_document_id || undefined,
        created_at: d.created_at,
        updated_at: d.updated_at || undefined,
      };
    });
  }

  async getDocument(documentId) {
    const result = await this._query(
      `SELECT document_id, data FROM vibe.documents
       WHERE client_id = 8 AND collection = 'vibe_agents' AND table_name = 'agent_documents'
       AND (data->>'document_id')::int = ${escapeSql(documentId)}
       LIMIT 1`
    );
    if (result.rows.length === 0) return null;
    const r = result.rows[0];
    const d = typeof r.data === 'string' ? JSON.parse(r.data) : r.data;
    return {
      id: d.document_id || r.document_id,
      title: d.title || d.filename || 'Untitled',
      content_md: d.content_md || '',
      type: d.document_type || 'attachment',
      author_agent: d.created_by ? String(d.created_by) : undefined,
      version: d.version || 1,
      parent_document_id: d.parent_document_id || undefined,
      created_at: d.created_at,
      updated_at: d.updated_at || undefined,
    };
  }

  async updateDocument(documentId, updates) {
    // Merge updates into existing JSONB data
    const existing = await this._query(
      `SELECT document_id, data FROM vibe.documents
       WHERE client_id = 8 AND collection = 'vibe_agents' AND table_name = 'agent_documents'
       AND (data->>'document_id')::int = ${escapeSql(documentId)}
       LIMIT 1`
    );
    if (existing.rows.length === 0) return null;
    const r = existing.rows[0];
    const d = typeof r.data === 'string' ? JSON.parse(r.data) : r.data;

    // Apply updates
    if (updates.title !== undefined) d.title = updates.title;
    if (updates.content_md !== undefined) d.content_md = updates.content_md;
    if (updates.document_type !== undefined) d.document_type = updates.document_type;
    if (updates.version !== undefined) d.version = updates.version;
    d.updated_at = new Date().toISOString();

    await this._query(
      `UPDATE vibe.documents SET data = ${escapeJsonb(d)}, updated_at = NOW()
       WHERE client_id = 8 AND collection = 'vibe_agents' AND table_name = 'agent_documents'
       AND (data->>'document_id')::int = ${escapeSql(documentId)}`
    );

    return {
      id: d.document_id || r.document_id,
      title: d.title || 'Untitled',
      content_md: d.content_md || '',
      type: d.document_type || 'attachment',
      author_agent: d.created_by ? String(d.created_by) : undefined,
      version: d.version || 1,
      created_at: d.created_at,
      updated_at: d.updated_at,
    };
  }

  async deleteDocument(documentId) {
    const result = await this._query(
      `DELETE FROM vibe.documents
       WHERE client_id = 8 AND collection = 'vibe_agents' AND table_name = 'agent_documents'
       AND (data->>'document_id')::int = ${escapeSql(documentId)}
       RETURNING document_id`
    );
    return result.rows.length > 0;
  }

  async listPoolProfiles() {
    const result = await this._query(
      `SELECT data FROM vibe.documents
       WHERE client_id = 8 AND collection = 'vibe_agents' AND table_name = 'contractor_pool'
       ORDER BY data->>'name'`
    );
    return result.rows.map(r => {
      const d = typeof r.data === 'string' ? JSON.parse(r.data) : r.data;
      return {
        name: d.name,
        displayName: d.display_name,
        description: d.description,
        model: d.model,
        tools: d.tools_json || [],
        sourcePath: d.source_path || '',
        isActive: d.is_active !== false,
      };
    });
  }

  async updateContractMessageId(contractId, messageId) {
    await this._query(
      `UPDATE agent_contracts SET contract_message_id = ${escapeSql(messageId)}
       WHERE id = ${escapeSql(contractId)}`
    );
  }

  async cancelContract(contractId, reason) {
    const now = new Date().toISOString();
    const result = await this._query(
      `UPDATE agent_contracts
       SET status = 'cancelled', completed_at = ${escapeSql(now)},
           cancel_reason = ${escapeSql(reason || null)}
       WHERE id = ${escapeSql(contractId)} AND status IN ('active', 'queued')
       RETURNING *`
    );
    return result.rows.length > 0 ? rowToCamel(result.rows[0]) : null;
  }

  async findActiveContractByContractorAndHirer(contractorAgentId, hiredByAgentId) {
    const result = await this._query(
      `SELECT * FROM agent_contracts
       WHERE contractor_agent_id = ${escapeSql(contractorAgentId)}
         AND hired_by_agent_id = ${escapeSql(hiredByAgentId)}
         AND status = 'active'
       ORDER BY created_at DESC LIMIT 1`
    );
    return result.rows.length > 0 ? rowToCamel(result.rows[0]) : null;
  }

  // --- Contractor v2: mailbox slots, promotion ---

  async assignMailboxSlot(contractId, slot) {
    const result = await this._query(
      `UPDATE agent_contracts SET mailbox_slot = ${escapeSql(slot)}
       WHERE id = ${escapeSql(contractId)} AND status = 'active'
       RETURNING *`
    );
    return result.rows.length > 0 ? rowToCamel(result.rows[0]) : null;
  }

  async freeMailboxSlot(contractId) {
    const result = await this._query(
      `UPDATE agent_contracts SET mailbox_slot = NULL
       WHERE id = ${escapeSql(contractId)}
       RETURNING *`
    );
    return result.rows.length > 0 ? rowToCamel(result.rows[0]) : null;
  }

  async isMailboxSlotOccupied(slot) {
    const result = await this._query(
      `SELECT c.id, a.name AS contractor_name FROM agent_contracts c
       JOIN agents a ON a.id = c.contractor_agent_id
       WHERE c.mailbox_slot = ${escapeSql(slot)} AND c.status = 'active'
       LIMIT 1`
    );
    return result.rows.length > 0 ? rowToCamel(result.rows[0]) : null;
  }

  async listActiveContractsByContractor(contractorAgentId) {
    const result = await this._query(
      `SELECT * FROM agent_contracts
       WHERE contractor_agent_id = ${escapeSql(contractorAgentId)}
         AND status = 'active'
       ORDER BY created_at DESC`
    );
    return result.rows.map(rowToCamel);
  }

  async promoteAgent(agentId) {
    // Change agent_type to 'team'
    await this._query(
      `UPDATE agents SET agent_type = 'team', updated_at = NOW()
       WHERE id = ${escapeSql(agentId)}`
    );
    // Close all active contracts with status 'promoted'
    const result = await this._query(
      `UPDATE agent_contracts
       SET status = 'promoted', completed_at = NOW(), mailbox_slot = NULL
       WHERE contractor_agent_id = ${escapeSql(agentId)} AND status IN ('active', 'queued')
       RETURNING *`
    );
    return result.rows.map(rowToCamel);
  }

  // ── Projects + App Config ─────────────────────────────────

  async listProjects() {
    const result = await this._query(`SELECT * FROM projects ORDER BY id`);
    return result.rows.map(rowToCamel);
  }

  async getProject(id) {
    const result = await this._query(`SELECT * FROM projects WHERE id = ${escapeSql(id)}`);
    return result.rows.length > 0 ? rowToCamel(result.rows[0]) : null;
  }

  async createProject(name, description) {
    const result = await this._query(
      `INSERT INTO projects (name, description) VALUES (${escapeSql(name)}, ${escapeSql(description || null)}) RETURNING *`
    );
    return result.rows.length > 0 ? rowToCamel(result.rows[0]) : null;
  }

  async updateProject(id, updates) {
    const sets = [];
    if (updates.name !== undefined) sets.push(`name = ${escapeSql(updates.name)}`);
    if (updates.description !== undefined) sets.push(`description = ${escapeSql(updates.description)}`);
    if (updates.status !== undefined) sets.push(`status = ${escapeSql(updates.status)}`);
    if (sets.length === 0) return this.getProject(id);
    sets.push(`updated_at = NOW()`);
    const result = await this._query(
      `UPDATE projects SET ${sets.join(', ')} WHERE id = ${escapeSql(id)} RETURNING *`
    );
    return result.rows.length > 0 ? rowToCamel(result.rows[0]) : null;
  }

  async getConfig(key) {
    const result = await this._query(`SELECT value FROM app_config WHERE key = ${escapeSql(key)}`);
    return result.rows.length > 0 ? result.rows[0].value : null;
  }

  async setConfig(key, value) {
    await this._query(
      `INSERT INTO app_config (key, value, updated_at) VALUES (${escapeSql(key)}, ${escapeSql(value)}, NOW())
       ON CONFLICT (key) DO UPDATE SET value = ${escapeSql(value)}, updated_at = NOW()`
    );
  }

  async getActiveProjectId() {
    const val = await this.getConfig('active_project_id');
    return val ? parseInt(val, 10) : null;
  }

  async setActiveProjectId(id) {
    await this.setConfig('active_project_id', String(id));
  }

  // --- Composed Profile (Phase 2: dynamic agent identity) ---

  async getGlobalAgentProfile(name) {
    const result = await this._query(
      `SELECT id, name, display_name, role, identity_md, role_md, philosophy_md, communication_md, response_pattern_md
       FROM vibe.global_vibe_agents
       WHERE name = ${escapeSql(name)} AND is_active = true`
    );
    if (result.rows.length === 0) return null;
    return rowToCamel(result.rows[0]);
  }

  async getAgentSkills(globalAgentId) {
    const result = await this._query(
      `SELECT s.name, s.display_name, s.instruction_md, ask.priority, ask.config_json
       FROM vibe.agent_skills ask
       JOIN vibe.skills s ON s.id = ask.skill_id
       WHERE ask.agent_id = ${escapeSql(globalAgentId)} AND s.is_active = true
       ORDER BY ask.priority, s.name`
    );
    return result.rows.map(rowToCamel);
  }

  _sessionFromRow(row) {
    return {
      sessionId: row.session_id,
      agentName: row.agent_name,
      character: row.character || null,
      customFunctions: row.custom_functions || {},
      preferences: row.preferences || {},
      memory: row.memory || {},
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      version: row.version || 1,
    };
  }
}

export { escapeSql, escapeJsonb };
