// Phase 1: Stub session manager - no persistence
// All agent data goes through Vibe API

export class SessionManager {
  constructor(_cfg) {
    this._sessions = new Map();
    // Agent roster is hydrated from VibeSQL at init() time.
    // Zero hardcoded names — canonical agent_profiles + team_agent_instances
    // are the one and only source of truth.
    this._agents = new Set();

    // Phase 1 stub: project registry is in-memory only, mirroring the one
    // authoritative row. Real store: vibe.documents where
    // client_id=9, collection='vibe_agents', table_name='vibe_projects'
    // (schema_id=63). See doc_id=8028 for vsql-server-dev / owner 22.
    // TODO replace with a real ProjectStore that queries VibeSQL Server
    // via POST /v1/query so list/create/select persist and match the DB,
    // scoped to the caller's client_id. Blocked on ACP not having a real
    // per-request client context plumbed through to SessionManager yet.
    this._projects = new Map([
      [1, {
        id: 1,
        name: 'vsql-server-dev',
        description: 'ACP dev project on 93 — VibeSQL consolidation spec',
        status: 'active',
      }],
    ]);
    this._activeProjectId = 1;
    this._nextProjectId = 2;

    // Phase 1 stub: agent documents registry is in-memory only. Real store
    // lives in vibe.documents alongside projects (client_id=9,
    // collection='vibe_agents'). Same TODO as projects: replace with a real
    // DocumentStore that queries VibeSQL Server once per-request client
    // context is plumbed through to SessionManager.
    this._documents = new Map();
    this._nextDocumentId = 1;

    // Documents loaded per-project from VibeSQL (vibe.documents).
    // No hardcoded seeds — every project sees only its own docs.

    // Kanban tasks now VibeSQL-backed (vibe.kanban_tasks)
    // Phase 1 in-memory _tasks Map removed 2026-05-06

    // Phase 1 stub: autonomy state is in-memory only. Supervisor writes
    // enabled/stopCondition/unattendedMode/etc. here via updateAutonomyState,
    // reads via getAutonomyState. Survives a single ACP session; doesn't
    // persist across restarts (which is actually fine — a restart should
    // clear unattended mode).
    this._autonomyState = null;
    this._standupEntries = [];
    this._nextStandupEntryId = 1;
  }

  async init() {
    // Hydrate the agent roster from VibeSQL so team-scoped agents
    // (e.g. nextpert-scout) resolve without a code change.
    await this._refreshAgentsRoster();
    return true;
  }

  async _refreshAgentsRoster() {
    try {
      // Canonical agent profiles — active only
      const canonicalResult = await this._queryVibeSql(
        `SELECT data->>'name' as name FROM vibe.documents ` +
        `WHERE collection = 'vibe_agents' AND table_name = 'agent_profiles' AND deleted_at IS NULL ` +
        `AND COALESCE((data->>'is_active')::boolean, true) = true`
      );
      if (canonicalResult.success && Array.isArray(canonicalResult.data)) {
        for (const row of canonicalResult.data) {
          if (row.name) this._agents.add(row.name);
        }
      }

      // Per-team agent instances — #207: the instance has no name column. Its addressable
      // identity is the CANONICAL bench name (agent_profiles.name), resolved via the agent_id
      // join. (team_unique_name was dropped; reading it would throw "column does not exist".)
      const teamResult = await this._queryVibeSql(
        `SELECT p.data->>'name' AS name ` +
        `FROM vibe_projects.team_agent_instances tai ` +
        `JOIN vibe.documents p ON p.collection = 'vibe_agents' AND p.table_name = 'agent_profiles' ` +
        `  AND p.deleted_at IS NULL AND (p.data->>'id')::int = tai.agent_id ` +
        `WHERE tai.is_active = TRUE`
      );
      if (teamResult.success && Array.isArray(teamResult.data)) {
        for (const row of teamResult.data) {
          if (row.name) this._agents.add(row.name);
        }
      }
    } catch (err) {
      // Fail-open: static fallback list stays intact if VibeSQL is unreachable
      console.warn('[SessionManager] _refreshAgentsRoster failed, using static fallback:', err?.message || err);
    }
  }

  async load(agentName) {
    const session = this._sessions.get(agentName);
    return session ? { session, source: 'memory' } : null;
  }

  async save(session) {
    if (!session.agentName) return false;
    this._sessions.set(session.agentName, session);
    return { savedTo: ['memory'] };
  }

  async delete(agentName) {
    this._sessions.delete(agentName);
    return true;
  }

  async list() {
    return Array.from(this._sessions.values());
  }

  // For localAuth middleware compatibility (case-insensitive lookup)
  async getAgentRegistration(agentId) {
    const name = agentId.replace('agent:', '');
    // Case-insensitive match against known agents
    const match = Array.from(this._agents).find(a => a.toLowerCase() === name.toLowerCase());
    if (match) {
      return { name: match, registered: true };
    }
    return null;
  }

  // Stub methods for agent storage (routes expect these)
  async getAgentProfileFromGlobal(name) {
    // Case-insensitive match
    const match = Array.from(this._agents).find(a => a.toLowerCase() === name.toLowerCase());
    if (match) {
      return {
        name: match,
        displayName: match,
        role: 'agent',
        isActive: true,
      };
    }
    return null;
  }

  async getAgentById(id) {
    // Stub - not implemented in Phase 1
    return null;
  }

  async updateAgent(id, updates) {
    // Stub - not implemented in Phase 1
    return { id, ...updates };
  }

  async listActiveAgents() {
    // Return all known agents as active
    return Array.from(this._agents).map(name => ({
      name,
      displayName: name,
      isActive: true,
    }));
  }

  async listAllAgents() {
    return this.listActiveAgents();
  }

  async softDeleteAgent(id) {
    // Stub - not implemented in Phase 1
    return true;
  }

  async upsertAgent(agentData) {
    // Stub - not implemented in Phase 1
    return { id: 1, ...agentData };
  }

  async bulkUpdateStartupOrder(order) {
    // Stub - not implemented in Phase 1
    return true;
  }

  async listPoolProfiles() {
    // Stub - not implemented in Phase 1
    return [];
  }

  async getAgentByName(name) {
    const match = Array.from(this._agents).find(a => a.toLowerCase() === name.toLowerCase());
    if (match) {
      return { name: match, id: 1 };
    }
    return null;
  }

  // -----------------------------------------------------------------------
  // Project registry — Phase 1 in-memory stub.
  // Backs api/routes/projects.ts so the Electron UI dropdown can load and
  // the active project can be selected. Persisted row for id=1 exists in
  // vibe.documents (client 9, agent_mail/vibe_projects) for the cloud mail
  // handler to satisfy ProjectExistsAsync; this in-memory copy mirrors it
  // so the local API doesn't need to hit VibeSQL on every list call.
  // -----------------------------------------------------------------------

  async listProjects() {
    return Array.from(this._projects.values());
  }

  async getProject(id) {
    const key = Number(id);
    return this._projects.get(key) || null;
  }

  async getActiveProjectId() {
    return this._activeProjectId;
  }

  async setActiveProjectId(id) {
    const key = Number(id);
    if (!this._projects.has(key)) return false;
    this._activeProjectId = key;
    return true;
  }

  async createProject(data) {
    if (!data || !data.name) {
      throw new Error('createProject: name is required');
    }
    const id = this._nextProjectId++;
    const project = {
      id,
      name: data.name,
      description: data.description || '',
      status: data.status || 'active',
      created_at: new Date().toISOString(),
    };
    this._projects.set(id, project);
    return project;
  }

  // -----------------------------------------------------------------------
  // Agent documents — Phase 1 in-memory stub.
  // Backs api/routes/documents.ts so the Electron DocumentSidebar stops
  // 500-ing on load. Returns an empty list until real VibeSQL wiring lands.
  // -----------------------------------------------------------------------

  async createDocument(fields) {
    const id = this._nextDocumentId++;
    const doc = {
      id,
      project_id: fields.project_id ?? null,
      title: fields.title ?? '',
      content_md: fields.content_md ?? '',
      type: fields.type ?? 'reference',
      version: fields.version ?? '1.0',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    this._documents.set(id, doc);
    return doc;
  }

  async listDocuments(filter = {}) {
    let docs = Array.from(this._documents.values());
    if (filter.project_id !== undefined) {
      docs = docs.filter(d => d.project_id === filter.project_id);
    }
    return docs;
  }

  async getDocument(id) {
    const key = Number(id);
    return this._documents.get(key) || null;
  }

  async updateDocument(id, updates) {
    const key = Number(id);
    const existing = this._documents.get(key);
    if (!existing) return null;
    const next = {
      ...existing,
      ...(updates.project_id !== undefined ? { project_id: updates.project_id } : {}),
      ...(updates.title !== undefined ? { title: updates.title } : {}),
      ...(updates.content_md !== undefined ? { content_md: updates.content_md } : {}),
      ...(updates.document_type !== undefined ? { type: updates.document_type } : {}),
      ...(updates.version !== undefined ? { version: updates.version } : {}),
      updated_at: new Date().toISOString(),
    };
    this._documents.set(key, next);
    return next;
  }

  async deleteDocument(id) {
    const key = Number(id);
    return this._documents.delete(key);
  }

  // -----------------------------------------------------------------------
  // Autonomy state — Phase 1 in-memory stub.
  // Backs autonomy/supervisor.js for unattended-mode start/stop/status.
  // State is a flat object merged by updateAutonomyState; null when
  // autonomy has never run this session. Doesn't persist across restarts,
  // which matches the desired behavior (restart = clean slate for unattended).
  // -----------------------------------------------------------------------

  async getAutonomyState() {
    return this._autonomyState;
  }

  async updateAutonomyState(partial) {
    this._autonomyState = {
      ...(this._autonomyState ?? {}),
      ...partial,
    };
    return this._autonomyState;
  }

  // Standup entries — in-memory ring for supervisor status writes.
  async createStandupEntry(entry) {
    const id = this._nextStandupEntryId++;
    const row = {
      id,
      created_at: new Date().toISOString(),
      ...entry,
    };
    this._standupEntries.push(row);
    // Keep the ring bounded so a long unattended run doesn't eat memory.
    if (this._standupEntries.length > 500) {
      this._standupEntries.splice(0, this._standupEntries.length - 500);
    }
    return id;
  }

  async listStandupEntries(filter = {}) {
    let rows = this._standupEntries.slice();
    if (filter.agent) {
      rows = rows.filter(r => r.agent === filter.agent);
    }
    if (filter.type) {
      rows = rows.filter(r => r.type === filter.type);
    }
    if (filter.limit) {
      rows = rows.slice(-filter.limit);
    }
    return rows;
  }

  // -----------------------------------------------------------------------
  // Kanban tasks — VibeSQL-backed store
  // Schema: vibe.kanban_tasks
  // -----------------------------------------------------------------------

  _vibeSqlUrl = process.env.VIBESQL_URL || 'http://10.0.0.93:52411';
  _vibeSqlSecret = process.env.VIBESQL_SECRET || 'ContainersSuperDevSecret';

  _escapeSql(value) {
    if (value === null || value === undefined) return 'NULL';
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) return 'NULL';
      return String(value);
    }
    if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
    return "'" + String(value).replace(/'/g, "''") + "'";
  }

  async _queryVibeSql(sql) {
    const res = await fetch(`${this._vibeSqlUrl}/v1/query`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Secret ${this._vibeSqlSecret}`,
      },
      body: JSON.stringify({ sql }),
    });
    const data = await res.json().catch(() => ({ success: false }));
    return data;
  }

  _rowToTask(row) {
    return {
      id: row.id,
      title: row.title,
      description: row.description,
      status: row.status,
      priority: row.priority,
      assignedTo: row.assigned_to,
      createdBy: row.created_by,
      specPath: row.spec_path,
      milestone: row.milestone,
      filesChanged: Array.isArray(row.files_changed) ? row.files_changed : (typeof row.files_changed === 'string' ? JSON.parse(row.files_changed) : []),
      blockers: row.blockers,
      archived: row.archived === true,
      projectId: row.project_id ?? null,
      created_at: row.created_at,
      updatedAt: row.updated_at,
      completedAt: row.completed_at,
    };
  }

  async createTask(task, projectId) {
    const now = new Date().toISOString();
    const cols = ['title', 'description', 'status', 'priority', 'assigned_to', 'created_by', 'spec_path', 'milestone', 'files_changed', 'blockers', 'created_at', 'updated_at', 'completed_at'];
    const vals = [
      this._escapeSql(task.title),
      this._escapeSql(task.description),
      this._escapeSql(task.status || 'backlog'),
      this._escapeSql(task.priority || 'medium'),
      this._escapeSql(task.assignedTo),
      this._escapeSql(task.createdBy),
      this._escapeSql(task.specPath),
      this._escapeSql(task.milestone),
      `${this._escapeSql(JSON.stringify(task.filesChanged || []))}::jsonb`,
      this._escapeSql(task.blockers),
      this._escapeSql(now),
      this._escapeSql(now),
      'NULL',
    ];
    if (projectId != null) {
      cols.push('project_id');
      vals.push(this._escapeSql(projectId));
    }
    const sql = `INSERT INTO vibe.kanban_tasks (${cols.join(', ')}) VALUES (${vals.join(', ')}) RETURNING id`;
    const result = await this._queryVibeSql(sql);
    if (!result.success || !result.data || result.data.length === 0) {
      throw new Error(result.error?.message || 'Failed to create kanban task');
    }
    return result.data[0].id;
  }

  async getTask(id, projectId) {
    let sql = `SELECT * FROM vibe.kanban_tasks WHERE id = ${Number(id)}`;
    if (projectId != null) {
      sql += ` AND project_id = ${this._escapeSql(projectId)}`;
    }
    const result = await this._queryVibeSql(sql);
    // Surface query failures — do NOT mask them as "not found" (a null here previously hid real SQL errors).
    if (!result.success) throw new Error(result.error?.message || 'Failed to query kanban task');
    if (!result.data || result.data.length === 0) return null;
    return this._rowToTask(result.data[0]);
  }

  async listTasks(filter = {}) {
    let sql = 'SELECT * FROM vibe.kanban_tasks WHERE 1=1';
    // #152 + #64 G5 UNION: archived (soft-deleted) tasks are EXCLUDED from the default
    // board. NULL-safe THREE-VALUED logic (#152, QA-verified edge): legacy rows where
    // archived IS NULL must still count as NOT archived — `archived = false` would DROP
    // them. Pass archived=true for the archived-only view, or includeArchived=true for both.
    if (filter.archived === true) {
      sql += ' AND archived IS TRUE';
    } else if (!filter.includeArchived) {
      sql += ' AND archived IS NOT TRUE';
    }
    // #64: project-scoped board.
    if (filter.projectId != null) {
      sql += ` AND project_id = ${this._escapeSql(filter.projectId)}`;
    }
    if (filter.status) {
      const statuses = Array.isArray(filter.status) ? filter.status : [filter.status];
      const statusList = statuses.map(s => this._escapeSql(s)).join(',');
      sql += ` AND status IN (${statusList})`;
    }
    if (filter.assignedTo) sql += ` AND assigned_to = ${this._escapeSql(filter.assignedTo)}`;
    if (filter.milestone) sql += ` AND milestone = ${this._escapeSql(filter.milestone)}`;
    if (filter.priority) sql += ` AND priority = ${this._escapeSql(filter.priority)}`;
    sql += ' ORDER BY id ASC';
    const result = await this._queryVibeSql(sql);
    // Surface query failures instead of returning [] — an empty array on a FAILED query is the masking
    // hole that hid the kanban write break (GET looked healthy while the query errored). Throw; the route
    // turns it into a real error response. Genuine empty results still return [].
    if (!result.success) throw new Error(result.error?.message || 'Failed to list kanban tasks');
    if (!result.data) return [];
    return result.data.map(r => this._rowToTask(r));
  }

  async updateTask(id, updates, projectId) {
    const sets = [];
    if (updates.status !== undefined) sets.push(`status = ${this._escapeSql(updates.status)}`);
    if (updates.priority !== undefined) sets.push(`priority = ${this._escapeSql(updates.priority)}`);
    if (updates.assignedTo !== undefined) sets.push(`assigned_to = ${this._escapeSql(updates.assignedTo)}`);
    if (updates.milestone !== undefined) sets.push(`milestone = ${this._escapeSql(updates.milestone)}`);
    if (updates.specPath !== undefined) sets.push(`spec_path = ${this._escapeSql(updates.specPath)}`);
    if (updates.blockers !== undefined) sets.push(`blockers = ${this._escapeSql(updates.blockers)}`);
    if (updates.description !== undefined) sets.push(`description = ${this._escapeSql(updates.description)}`);
    if (updates.title !== undefined) sets.push(`title = ${this._escapeSql(updates.title)}`);
    if (updates.filesChanged !== undefined) sets.push(`files_changed = ${this._escapeSql(JSON.stringify(updates.filesChanged))}::jsonb`);
    if (updates.updatedAt !== undefined) sets.push(`updated_at = ${this._escapeSql(updates.updatedAt)}`);
    if (updates.completedAt !== undefined) sets.push(`completed_at = ${updates.completedAt ? this._escapeSql(updates.completedAt) : 'NULL'}`);
    if (updates.archived !== undefined) sets.push(`archived = ${updates.archived ? 'TRUE' : 'FALSE'}`);
    if (sets.length === 0) return this.getTask(id, projectId);
    let sql = `UPDATE vibe.kanban_tasks SET ${sets.join(', ')} WHERE id = ${Number(id)}`;
    if (projectId != null) {
      sql += ` AND project_id = ${this._escapeSql(projectId)}`;
    }
    sql += ' RETURNING *';
    const result = await this._queryVibeSql(sql);
    // Surface query failures — do NOT mask them as "no row updated".
    if (!result.success) throw new Error(result.error?.message || 'Failed to update kanban task');
    if (!result.data || result.data.length === 0) return null;
    return this._rowToTask(result.data[0]);
  }

  // ── #64 G4: kanban activity / audit trail (vibe.kanban_activity) ──────────
  async appendKanbanActivity({ taskId, actor, action, fromStatus, toStatus, detail, projectId }) {
    const sql = `INSERT INTO vibe.kanban_activity (task_id, actor, action, from_status, to_status, detail, project_id)
      VALUES (${Number(taskId)}, ${this._escapeSql(actor)}, ${this._escapeSql(action)}, ${this._escapeSql(fromStatus)}, ${this._escapeSql(toStatus)}, ${this._escapeSql(detail)}, ${projectId != null ? Number(projectId) : 'NULL'})
      RETURNING activity_id`;
    const result = await this._queryVibeSql(sql);
    if (!result.success) throw new Error(result.error?.message || 'Failed to append kanban activity');
    return result.data?.[0]?.activity_id ?? null;
  }

  async listKanbanActivity(taskId, projectId) {
    let sql = `SELECT activity_id, task_id, actor, action, from_status, to_status, detail, at FROM vibe.kanban_activity WHERE task_id = ${Number(taskId)}`;
    if (projectId != null) sql += ` AND (project_id = ${Number(projectId)} OR project_id IS NULL)`;
    sql += ' ORDER BY at ASC, activity_id ASC';
    const result = await this._queryVibeSql(sql);
    if (!result.success) throw new Error(result.error?.message || 'Failed to list kanban activity');
    return (result.data || []).map(r => ({
      activity_id: r.activity_id, task_id: r.task_id, actor: r.actor, action: r.action,
      from: r.from_status, to: r.to_status, detail: r.detail, at: r.at,
    }));
  }

  // ── #64 G3: kanban comments thread (vibe.kanban_comments) ────────────────
  async addKanbanComment({ taskId, author, bodyMd, projectId }) {
    const sql = `INSERT INTO vibe.kanban_comments (task_id, author, body_md, project_id)
      VALUES (${Number(taskId)}, ${this._escapeSql(author)}, ${this._escapeSql(bodyMd)}, ${projectId != null ? Number(projectId) : 'NULL'})
      RETURNING comment_id, task_id, author, body_md, created_at`;
    const result = await this._queryVibeSql(sql);
    if (!result.success) throw new Error(result.error?.message || 'Failed to add kanban comment');
    const r = result.data?.[0];
    return r ? { comment_id: r.comment_id, task_id: r.task_id, author: r.author, body_md: r.body_md, created_at: r.created_at } : null;
  }

  async listKanbanComments(taskId, projectId) {
    let sql = `SELECT comment_id, task_id, author, body_md, created_at FROM vibe.kanban_comments WHERE task_id = ${Number(taskId)}`;
    if (projectId != null) sql += ` AND (project_id = ${Number(projectId)} OR project_id IS NULL)`;
    sql += ' ORDER BY created_at ASC, comment_id ASC';
    const result = await this._queryVibeSql(sql);
    if (!result.success) throw new Error(result.error?.message || 'Failed to list kanban comments');
    return (result.data || []).map(r => ({ comment_id: r.comment_id, task_id: r.task_id, author: r.author, body_md: r.body_md, created_at: r.created_at }));
  }

  get storage() {
    // Return stub storage for compatibility
    const self = this;
    return {
      getSession: (name) => this.load(name),
      saveSession: (s) => this.save(s),
      deleteSession: (name) => this.delete(name),
      listSessions: () => this.list(),
      getAgentRegistration: (id) => this.getAgentRegistration(id),
      init: () => Promise.resolve(),
      // Agent storage methods
      getAgentProfileFromGlobal: (name) => self.getAgentProfileFromGlobal(name),
      getAgentById: (id) => self.getAgentById(id),
      updateAgent: (id, updates) => self.updateAgent(id, updates),
      listActiveAgents: () => self.listActiveAgents(),
      listAllAgents: () => self.listAllAgents(),
      softDeleteAgent: (id) => self.softDeleteAgent(id),
      upsertAgent: (data) => self.upsertAgent(data),
      bulkUpdateStartupOrder: (order) => self.bulkUpdateStartupOrder(order),
      listPoolProfiles: () => self.listPoolProfiles(),
      getAgentByName: (name) => self.getAgentByName(name),
      // Project registry — forwards to the in-memory Phase 1 stub above.
      listProjects: () => self.listProjects(),
      getProject: (id) => self.getProject(id),
      getActiveProjectId: () => self.getActiveProjectId(),
      setActiveProjectId: (id) => self.setActiveProjectId(id),
      createProject: (data) => self.createProject(data),
      // Agent documents — forwards to the in-memory Phase 1 stub above.
      createDocument: (fields) => self.createDocument(fields),
      listDocuments: (filter) => self.listDocuments(filter),
      getDocument: (id) => self.getDocument(id),
      updateDocument: (id, updates) => self.updateDocument(id, updates),
      deleteDocument: (id) => self.deleteDocument(id),
      // Kanban tasks — forwards to the in-memory Phase 1 stub above.
      createTask: (data, projectId) => self.createTask(data, projectId),
      getTask: (id, projectId) => self.getTask(id, projectId),
      listTasks: (filter) => self.listTasks(filter),
      updateTask: (id, updates, projectId) => self.updateTask(id, updates, projectId),
      // #64 kanban mutation surface — activity (G4) + comments (G3)
      appendKanbanActivity: (e) => self.appendKanbanActivity(e),
      listKanbanActivity: (id, projectId) => self.listKanbanActivity(id, projectId),
      addKanbanComment: (c) => self.addKanbanComment(c),
      listKanbanComments: (id, projectId) => self.listKanbanComments(id, projectId),
      // Autonomy state + standup entries — forwards to the stubs above.
      getAutonomyState: () => self.getAutonomyState(),
      updateAutonomyState: (partial) => self.updateAutonomyState(partial),
      createStandupEntry: (entry) => self.createStandupEntry(entry),
      listStandupEntries: (filter) => self.listStandupEntries(filter),
    };
  }
}
