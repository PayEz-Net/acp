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
  'connectionInfo', 'capabilities'
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

export class VibeSqlClient {
  constructor(cfg) {
    this._config = cfg || defaultConfig;
  }

  async _query(sql) {
    const url = `${this._config.vibesqlUrl}/v1/query`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
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
    // Normalize response: VibeSQL omits 'rows' field on empty results
    if (data.rows === undefined) {
      data.rows = [];
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
    const result = await this._query(
      `SELECT id FROM agent_sessions WHERE agent_name = ${escapeSql(session.agentName)}`
    );
    if (result.rows.length > 0) {
      await this._query(`UPDATE agent_sessions SET
        session_id = ${escapeSql(session.sessionId)},
        character = ${escapeSql(session.character || null)},
        custom_functions = ${escapeJsonb(session.customFunctions || {})},
        preferences = ${escapeJsonb(session.preferences || {})},
        memory = ${escapeJsonb(session.memory || {})},
        updated_at = ${escapeSql(now)},
        version = ${escapeSql(session.version || 1)}
        WHERE agent_name = ${escapeSql(session.agentName)}`);
    } else {
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
        )`);
    }
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
    const result = await this._query(
      `SELECT id FROM agent_signals WHERE agent_id = ${escapeSql(signal.agentId)}`
    );
    if (result.rows.length > 0) {
      await this._query(`UPDATE agent_signals SET
        agent_name = ${escapeSql(signal.agentName)},
        zone = ${escapeSql(signal.zone || 'entrance')},
        working_on = ${escapeSql(signal.workingOn || null)},
        keywords = ${escapeJsonb(signal.keywords || [])},
        needs = ${escapeJsonb(signal.needs || [])},
        offers = ${escapeJsonb(signal.offers || [])},
        updated_at = ${escapeSql(now)}
        WHERE agent_id = ${escapeSql(signal.agentId)}`);
    } else {
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
        )`);
    }
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
    const result = await this._query(
      `SELECT id FROM agent_relevance WHERE observer_agent = ${escapeSql(rel.observerAgent)} AND subject_agent = ${escapeSql(rel.subjectAgent)}`
    );
    if (result.rows.length > 0) {
      await this._query(`UPDATE agent_relevance SET
        domain_tags = ${escapeJsonb(rel.domainTags || [])},
        typical_offers = ${escapeJsonb(rel.typicalOffers || [])},
        typical_needs = ${escapeJsonb(rel.typicalNeeds || [])},
        recent_keywords = ${escapeJsonb(rel.recentKeywords || [])},
        last_broadcast_ts = ${escapeSql(rel.lastBroadcastTs || null)},
        total_mingles = ${escapeSql(rel.totalMingles || 0)},
        successful_mingles = ${escapeSql(rel.successfulMingles || 0)},
        last_mingle_ts = ${escapeSql(rel.lastMingleTs || null)},
        last_mingle_outcome = ${escapeSql(rel.lastMingleOutcome || null)},
        base_relevance = ${escapeSql(rel.baseRelevance || 0)},
        recent_relevance = ${escapeSql(rel.recentRelevance || 0)},
        interaction_score = ${escapeSql(rel.interactionScore ?? 0.5)},
        combined_score = ${escapeSql(rel.combinedScore || 0)}
        WHERE observer_agent = ${escapeSql(rel.observerAgent)} AND subject_agent = ${escapeSql(rel.subjectAgent)}`);
    } else {
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
        )`);
    }
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
    return result.rows[0]?.id;
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
    const result = await this._query(`INSERT INTO kanban_tasks
      (title, description, status, priority, assigned_to, created_by, spec_path, milestone, files_changed, blockers, created_at)
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
        ${escapeSql(task.createdAt || now)}
      ) RETURNING id`);
    return result.rows[0]?.id;
  }

  async getTask(id) {
    const result = await this._query(`SELECT * FROM kanban_tasks WHERE id = ${escapeSql(id)}`);
    if (result.rows.length === 0) return null;
    return rowToCamel(result.rows[0]);
  }

  async listTasks(filter = {}) {
    const conditions = ['1=1'];
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
    await this._query(`INSERT INTO standup_entries
      (agent_name, entry_type, summary, task_id, created_at)
      VALUES (
        ${escapeSql(entry.agentName)},
        ${escapeSql(entry.entryType)},
        ${escapeSql(entry.summary)},
        ${escapeSql(entry.taskId || null)},
        ${escapeSql(entry.createdAt || now)}
      )`);
  }

  async listStandupEntries(filter = {}) {
    const conditions = ['1=1'];
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
    const result = await this._query(
      `SELECT agent_id FROM acp_runtime_registry WHERE agent_id = ${escapeSql(reg.agentId)}`
    );
    if (result.rows.length > 0) {
      await this._query(`UPDATE acp_runtime_registry SET
        runtime = ${escapeSql(reg.runtime)},
        adapter = ${escapeSql(reg.adapter)},
        connection_info = ${escapeJsonb(reg.connectionInfo || {})},
        capabilities = ${escapeJsonb(reg.capabilities || {})},
        last_heartbeat = NOW()
        WHERE agent_id = ${escapeSql(reg.agentId)}`);
    } else {
      await this._query(`INSERT INTO acp_runtime_registry
        (agent_id, runtime, adapter, connection_info, capabilities)
        VALUES (
          ${escapeSql(reg.agentId)},
          ${escapeSql(reg.runtime)},
          ${escapeSql(reg.adapter)},
          ${escapeJsonb(reg.connectionInfo || {})},
          ${escapeJsonb(reg.capabilities || {})}
        )`);
    }
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
      `SELECT * FROM agents WHERE name = ${escapeSql(name)}`
    );
    if (result.rows.length === 0) return null;
    return rowToCamel(result.rows[0]);
  }

  async getAgentById(id) {
    const result = await this._query(
      `SELECT * FROM agents WHERE id = ${escapeSql(id)}`
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
    sets.push(`updated_at = NOW()`);
    await this._query(`UPDATE agents SET ${sets.join(', ')} WHERE id = ${escapeSql(id)}`);
  }

  async listAgentsByType(agentType) {
    const result = await this._query(
      `SELECT * FROM agents WHERE agent_type = ${escapeSql(agentType)} ORDER BY name`
    );
    return result.rows.map(rowToCamel);
  }

  // --- Agent Contracts ---

  async createContract(contract) {
    const result = await this._query(
      `INSERT INTO agent_contracts
        (contractor_agent_id, hired_by_agent_id, contract_subject, contract_message_id, profile_source, profile_snapshot, timeout_hours)
       VALUES (
         ${escapeSql(contract.contractorAgentId)},
         ${escapeSql(contract.hiredByAgentId)},
         ${escapeSql(contract.contractSubject)},
         ${escapeSql(contract.contractMessageId || null)},
         ${escapeSql(contract.profileSource || null)},
         ${escapeJsonb(contract.profileSnapshot || null)},
         ${escapeSql(contract.timeoutHours ?? 72)}
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

  async listActiveContracts() {
    const result = await this._query(
      `SELECT c.*, a.name AS contractor_name, a.display_name AS contractor_display_name,
              a.role AS contractor_role, a.model AS contractor_model, a.expertise_json AS contractor_expertise,
              h.name AS hired_by_name
       FROM agent_contracts c
       JOIN agents a ON a.id = c.contractor_agent_id
       JOIN agents h ON h.id = c.hired_by_agent_id
       WHERE c.status = 'active'
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
       WHERE id = ${escapeSql(contractId)} AND status = 'active'
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

  async updateContractMessageId(contractId, messageId) {
    await this._query(
      `UPDATE agent_contracts SET contract_message_id = ${escapeSql(messageId)}
       WHERE id = ${escapeSql(contractId)}`
    );
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
