import { createHmac } from 'node:crypto';
import { execSync } from 'node:child_process';
import { config as defaultConfig } from '../config.js';

const COLLECTION = 'acp';

let cachedToken = null;
let tokenExpiresAt = 0;

function getBearerToken(cfg) {
  if (cachedToken && Date.now() < tokenExpiresAt) return cachedToken;
  try {
    const output = execSync(cfg.vibeTokenCmd, { encoding: 'utf8' });
    const result = JSON.parse(output);
    cachedToken = result.access_token;
    tokenExpiresAt = Date.now() + (cfg.vibeTokenRefreshS * 1000);
    return cachedToken;
  } catch (err) {
    const tokenErr = new Error(`Bearer token retrieval failed: ${err.message}`);
    tokenErr.code = 'TOKEN_RETRIEVAL_FAILED';
    throw tokenErr;
  }
}

function getHmacHeaders(cfg, method, path) {
  const timestamp = Math.floor(Date.now() / 1000);
  const stringToSign = `${timestamp}|${method}|${path}`;
  const key = Buffer.from(cfg.vibeSigningKey, 'base64');
  const signature = createHmac('sha256', key).update(stringToSign).digest('base64');
  return {
    'Content-Type': 'application/json',
    'X-Vibe-Client-Id': String(cfg.vibeClientId),
    'X-Vibe-Timestamp': String(timestamp),
    'X-Vibe-Signature': signature,
  };
}

function getHeaders(cfg, method, path) {
  if (cfg.vibeAuthMode === 'hmac') {
    return getHmacHeaders(cfg, method, path);
  }
  return {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${getBearerToken(cfg)}`,
    'X-Vibe-Client-Id': String(cfg.vibeClientId),
  };
}

export class VibeApiClient {
  constructor(cfg) {
    this._config = cfg || defaultConfig;
  }

  async _apiCall(method, path, body) {
    const headers = getHeaders(this._config, method, path);
    const opts = { method, headers };
    if (body !== undefined) opts.body = JSON.stringify(body);
    const res = await fetch(`${this._config.vibeApiUrl}${path}`, opts);
    if (!res.ok) {
      const errBody = await res.json().catch(() => ({}));
      const err = new Error(errBody.message || `Vibe API ${res.status}`);
      err.statusCode = res.status;
      err.code = errBody.error?.code || 'VIBE_API_ERROR';
      throw err;
    }
    if (res.status === 204) return null;
    return res.json();
  }

  async init() {
    const tables = [
      'agent_sessions', 'agent_signals', 'agent_relevance', 'mingle_sessions',
      'messages', 'chat_clusters', 'kanban_tasks', 'autonomy_state',
      'standup_entries', 'escalation_log',
    ];
    for (const table of tables) {
      try {
        await this._apiCall('PUT', `/v1/schemas/${COLLECTION}/${table}`, {
          name: table,
          collection: COLLECTION,
        });
      } catch {
        // Schema may already exist or endpoint may not support registration
      }
    }
  }

  async getSession(agentName) {
    const path = `/v1/schemas/${COLLECTION}/documents/agent_sessions/query`;
    const result = await this._apiCall('POST', path, { filter: { agent_name: agentName } });
    const rows = result?.data || result?.rows || [];
    if (rows.length === 0) return null;
    return this._fromDoc(rows[0]);
  }

  async saveSession(session) {
    const existing = await this.getSession(session.agentName);
    const doc = this._toDoc(session);
    if (existing && existing._docId) {
      const path = `/v1/schemas/${COLLECTION}/documents/agent_sessions/${existing._docId}`;
      await this._apiCall('PUT', path, doc);
    } else {
      const path = `/v1/schemas/${COLLECTION}/documents/agent_sessions`;
      await this._apiCall('POST', path, doc);
    }
  }

  async deleteSession(agentName) {
    const existing = await this.getSession(agentName);
    if (existing && existing._docId) {
      const path = `/v1/schemas/${COLLECTION}/documents/agent_sessions/${existing._docId}`;
      await this._apiCall('DELETE', path);
    }
  }

  async listSessions() {
    const path = `/v1/schemas/${COLLECTION}/documents/agent_sessions`;
    const result = await this._apiCall('GET', path);
    const rows = result?.data || result?.rows || [];
    return rows.map((r) => this._fromDoc(r));
  }

  async upsertSignal(signal) {
    const path = `/v1/schemas/${COLLECTION}/documents/agent_signals/query`;
    const result = await this._apiCall('POST', path, { filter: { agent_id: signal.agentId } });
    const rows = result?.data || result?.rows || [];
    const now = new Date().toISOString();
    const doc = {
      agent_id: signal.agentId,
      agent_name: signal.agentName,
      zone: signal.zone || 'entrance',
      working_on: signal.workingOn || null,
      keywords: signal.keywords || [],
      needs: signal.needs || [],
      offers: signal.offers || [],
      updated_at: now,
    };
    if (rows.length > 0 && rows[0].id) {
      await this._apiCall('PUT', `/v1/schemas/${COLLECTION}/documents/agent_signals/${rows[0].id}`, doc);
    } else {
      doc.created_at = now;
      await this._apiCall('POST', `/v1/schemas/${COLLECTION}/documents/agent_signals`, doc);
    }
  }

  async getSignal(agentId) {
    const path = `/v1/schemas/${COLLECTION}/documents/agent_signals/query`;
    const result = await this._apiCall('POST', path, { filter: { agent_id: agentId } });
    const rows = result?.data || result?.rows || [];
    return rows.length > 0 ? rows[0] : null;
  }

  async listSignals() {
    const result = await this._apiCall('GET', `/v1/schemas/${COLLECTION}/documents/agent_signals`);
    return result?.data || result?.rows || [];
  }

  async upsertRelevance(rel) {
    const path = `/v1/schemas/${COLLECTION}/documents/agent_relevance/query`;
    const result = await this._apiCall('POST', path, {
      filter: { observer_agent: rel.observerAgent, subject_agent: rel.subjectAgent },
    });
    const rows = result?.data || result?.rows || [];
    const doc = {
      observer_agent: rel.observerAgent,
      subject_agent: rel.subjectAgent,
      domain_tags: rel.domainTags || [],
      typical_offers: rel.typicalOffers || [],
      typical_needs: rel.typicalNeeds || [],
      recent_keywords: rel.recentKeywords || [],
      last_broadcast_ts: rel.lastBroadcastTs || null,
      total_mingles: rel.totalMingles || 0,
      successful_mingles: rel.successfulMingles || 0,
      last_mingle_ts: rel.lastMingleTs || null,
      last_mingle_outcome: rel.lastMingleOutcome || null,
      base_relevance: rel.baseRelevance || 0,
      recent_relevance: rel.recentRelevance || 0,
      interaction_score: rel.interactionScore ?? 0.5,
      combined_score: rel.combinedScore || 0,
    };
    if (rows.length > 0 && rows[0].id) {
      await this._apiCall('PUT', `/v1/schemas/${COLLECTION}/documents/agent_relevance/${rows[0].id}`, doc);
    } else {
      await this._apiCall('POST', `/v1/schemas/${COLLECTION}/documents/agent_relevance`, doc);
    }
  }

  async getRelevance(observer, subject) {
    const path = `/v1/schemas/${COLLECTION}/documents/agent_relevance/query`;
    const result = await this._apiCall('POST', path, {
      filter: { observer_agent: observer, subject_agent: subject },
    });
    const rows = result?.data || result?.rows || [];
    return rows.length > 0 ? rows[0] : null;
  }

  async listRelevance(observer) {
    const path = `/v1/schemas/${COLLECTION}/documents/agent_relevance/query`;
    const result = await this._apiCall('POST', path, { filter: { observer_agent: observer } });
    return result?.data || result?.rows || [];
  }

  async createMingle(mingle) {
    const now = new Date().toISOString();
    const doc = {
      mingle_id: mingle.mingleId,
      agent_a: mingle.agentA,
      agent_b: mingle.agentB,
      interaction_type: mingle.interactionType || 'chit_chat',
      topic: mingle.topic || null,
      outcome: mingle.outcome || 'pending',
      started_at: mingle.startedAt || now,
    };
    await this._apiCall('POST', `/v1/schemas/${COLLECTION}/documents/mingle_sessions`, doc);
  }

  async updateMingle(id, updates) {
    const path = `/v1/schemas/${COLLECTION}/documents/mingle_sessions/query`;
    const result = await this._apiCall('POST', path, { filter: { mingle_id: id } });
    const rows = result?.data || result?.rows || [];
    if (rows.length > 0 && rows[0].id) {
      const doc = {};
      if (updates.outcome !== undefined) doc.outcome = updates.outcome;
      if (updates.endedAt !== undefined) doc.ended_at = updates.endedAt;
      await this._apiCall('PUT', `/v1/schemas/${COLLECTION}/documents/mingle_sessions/${rows[0].id}`, doc);
    }
  }

  async listActiveMingles() {
    const path = `/v1/schemas/${COLLECTION}/documents/mingle_sessions/query`;
    const result = await this._apiCall('POST', path, { filter: { outcome: 'pending' } });
    return result?.data || result?.rows || [];
  }

  async createMessage(msg) {
    const now = new Date().toISOString();
    const doc = {
      message_type: msg.messageType,
      channel: msg.channel || null,
      cluster_id: msg.clusterId || null,
      from_agent: msg.fromAgent,
      to_agent: msg.toAgent || null,
      subject: msg.subject || null,
      body: msg.body,
      priority: msg.priority || 'normal',
      keywords: msg.keywords || [],
      is_read: false,
      is_archived: false,
      created_at: msg.createdAt || now,
    };
    const result = await this._apiCall('POST', `/v1/schemas/${COLLECTION}/documents/messages`, doc);
    return result?.data?.id || result?.id;
  }

  async getMessages(filter = {}) {
    const path = `/v1/schemas/${COLLECTION}/documents/messages/query`;
    const queryFilter = {};
    if (filter.messageType) queryFilter.message_type = filter.messageType;
    if (filter.toAgent) queryFilter.to_agent = filter.toAgent;
    if (filter.fromAgent) queryFilter.from_agent = filter.fromAgent;
    if (filter.channel) queryFilter.channel = filter.channel;
    if (filter.clusterId) queryFilter.cluster_id = filter.clusterId;
    if (filter.isRead !== undefined) queryFilter.is_read = filter.isRead;
    if (filter.isArchived !== undefined) queryFilter.is_archived = filter.isArchived;
    const result = await this._apiCall('POST', path, { filter: queryFilter });
    return result?.data || result?.rows || [];
  }

  async markRead(id) {
    await this._apiCall('PUT', `/v1/schemas/${COLLECTION}/documents/messages/${id}`, {
      is_read: true,
      read_at: new Date().toISOString(),
    });
  }

  async archiveMessage(id) {
    await this._apiCall('PUT', `/v1/schemas/${COLLECTION}/documents/messages/${id}`, {
      is_archived: true,
    });
  }

  async markAllRead(agentName) {
    const path = `/v1/schemas/${COLLECTION}/documents/messages/query`;
    const result = await this._apiCall('POST', path, { filter: { to_agent: agentName, is_read: false } });
    const unread = result?.data || result?.rows || [];
    for (const msg of unread) {
      if (msg.id) await this.markRead(msg.id);
    }
  }

  async createCluster(cluster) {
    const now = new Date().toISOString();
    const doc = {
      cluster_id: cluster.clusterId,
      topic: cluster.topic || null,
      members: cluster.members || [],
      status: cluster.status || 'active',
      zone: cluster.zone || 'bar',
      formed_at: cluster.formedAt || now,
    };
    await this._apiCall('POST', `/v1/schemas/${COLLECTION}/documents/chat_clusters`, doc);
  }

  async getCluster(clusterId) {
    const path = `/v1/schemas/${COLLECTION}/documents/chat_clusters/query`;
    const result = await this._apiCall('POST', path, { filter: { cluster_id: clusterId } });
    const rows = result?.data || result?.rows || [];
    return rows.length > 0 ? rows[0] : null;
  }

  async updateCluster(id, updates) {
    const path = `/v1/schemas/${COLLECTION}/documents/chat_clusters/query`;
    const result = await this._apiCall('POST', path, { filter: { cluster_id: id } });
    const rows = result?.data || result?.rows || [];
    if (rows.length > 0 && rows[0].id) {
      const doc = {};
      if (updates.members !== undefined) doc.members = updates.members;
      if (updates.status !== undefined) doc.status = updates.status;
      if (updates.dissolvedAt !== undefined) doc.dissolved_at = updates.dissolvedAt;
      await this._apiCall('PUT', `/v1/schemas/${COLLECTION}/documents/chat_clusters/${rows[0].id}`, doc);
    }
  }

  async createTask(task) {
    const now = new Date().toISOString();
    const doc = {
      title: task.title,
      description: task.description || null,
      status: task.status || 'backlog',
      priority: task.priority || 'medium',
      assigned_to: task.assignedTo || null,
      created_by: task.createdBy || null,
      spec_path: task.specPath || null,
      milestone: task.milestone || null,
      files_changed: task.filesChanged || [],
      blockers: task.blockers || null,
      created_at: task.createdAt || now,
    };
    const result = await this._apiCall('POST', `/v1/schemas/${COLLECTION}/documents/kanban_tasks`, doc);
    return result?.data?.id || result?.id;
  }

  async getTask(id) {
    const result = await this._apiCall('GET', `/v1/schemas/${COLLECTION}/documents/kanban_tasks/${id}`);
    return result?.data || result;
  }

  async listTasks(filter = {}) {
    const path = `/v1/schemas/${COLLECTION}/documents/kanban_tasks/query`;
    const queryFilter = {};
    if (filter.status) queryFilter.status = filter.status;
    if (filter.assignedTo) queryFilter.assigned_to = filter.assignedTo;
    if (filter.milestone) queryFilter.milestone = filter.milestone;
    if (filter.priority) queryFilter.priority = filter.priority;
    const result = await this._apiCall('POST', path, { filter: queryFilter });
    return result?.data || result?.rows || [];
  }

  async updateTask(id, updates) {
    const now = new Date().toISOString();
    const doc = { updated_at: now };
    if (updates.status !== undefined) doc.status = updates.status;
    if (updates.assignedTo !== undefined) doc.assigned_to = updates.assignedTo;
    if (updates.reviewNotes !== undefined) doc.review_notes = updates.reviewNotes;
    if (updates.reviewedBy !== undefined) doc.reviewed_by = updates.reviewedBy;
    if (updates.filesChanged !== undefined) doc.files_changed = updates.filesChanged;
    if (updates.blockers !== undefined) doc.blockers = updates.blockers;
    if (updates.completedAt !== undefined) doc.completed_at = updates.completedAt;
    await this._apiCall('PUT', `/v1/schemas/${COLLECTION}/documents/kanban_tasks/${id}`, doc);
  }

  async deleteTask(id) {
    await this._apiCall('DELETE', `/v1/schemas/${COLLECTION}/documents/kanban_tasks/${id}`);
  }

  async getAutonomyState() {
    const result = await this._apiCall('GET', `/v1/schemas/${COLLECTION}/documents/autonomy_state`);
    const rows = result?.data || result?.rows || [];
    return rows.length > 0 ? rows[0] : null;
  }

  async updateAutonomyState(updates) {
    const existing = await this.getAutonomyState();
    const doc = {};
    for (const [key, val] of Object.entries(updates)) {
      const snakeKey = key.replace(/[A-Z]/g, (c) => '_' + c.toLowerCase());
      doc[snakeKey] = val;
    }
    if (existing && existing.id) {
      await this._apiCall('PUT', `/v1/schemas/${COLLECTION}/documents/autonomy_state/${existing.id}`, doc);
    } else {
      await this._apiCall('POST', `/v1/schemas/${COLLECTION}/documents/autonomy_state`, doc);
    }
  }

  async createStandupEntry(entry) {
    const now = new Date().toISOString();
    const doc = {
      agent_name: entry.agentName,
      entry_type: entry.entryType,
      summary: entry.summary,
      task_id: entry.taskId || null,
      created_at: entry.createdAt || now,
    };
    await this._apiCall('POST', `/v1/schemas/${COLLECTION}/documents/standup_entries`, doc);
  }

  async listStandupEntries(filter = {}) {
    const path = `/v1/schemas/${COLLECTION}/documents/standup_entries/query`;
    const queryFilter = {};
    if (filter.agentName) queryFilter.agent_name = filter.agentName;
    if (filter.entryType) queryFilter.entry_type = filter.entryType;
    const result = await this._apiCall('POST', path, { filter: queryFilter });
    return result?.data || result?.rows || [];
  }

  async createEscalation(esc) {
    const now = new Date().toISOString();
    const doc = {
      sensitivity_level: esc.sensitivityLevel,
      trigger_type: esc.triggerType,
      summary: esc.summary,
      shutdown_mode: esc.shutdownMode || 'soft',
      created_at: esc.createdAt || now,
    };
    await this._apiCall('POST', `/v1/schemas/${COLLECTION}/documents/escalation_log`, doc);
  }

  async listEscalations(filter = {}) {
    const path = `/v1/schemas/${COLLECTION}/documents/escalation_log/query`;
    const queryFilter = {};
    if (filter.resolved !== undefined) queryFilter.resolved = filter.resolved;
    const result = await this._apiCall('POST', path, { filter: queryFilter });
    return result?.data || result?.rows || [];
  }

  _toDoc(session) {
    return {
      session_id: session.sessionId,
      agent_name: session.agentName,
      character: session.character || null,
      custom_functions: session.customFunctions || {},
      preferences: session.preferences || {},
      memory: session.memory || {},
      created_at: session.createdAt,
      updated_at: session.updatedAt || new Date().toISOString(),
      version: session.version || 1,
    };
  }

  _fromDoc(doc) {
    const data = doc.data || doc;
    const docId = doc.id || data.id;
    const session = {
      sessionId: data.session_id || data.sessionId,
      agentName: data.agent_name || data.agentName,
      character: data.character || null,
      customFunctions: data.custom_functions || data.customFunctions || {},
      preferences: data.preferences || {},
      memory: data.memory || {},
      createdAt: data.created_at || data.createdAt,
      updatedAt: data.updated_at || data.updatedAt,
      version: data.version || 1,
    };
    Object.defineProperty(session, '_docId', { value: docId, enumerable: false });
    return session;
  }
}
