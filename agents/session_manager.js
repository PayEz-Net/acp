// Phase 1: Stub session manager - no persistence
// All agent data goes through Vibe API

export class SessionManager {
  constructor(_cfg) {
    this._sessions = new Map();
    // Pre-populate known agents for local auth.
    // BAPert-Jon is Jon's external orchestrator identity — distinct from
    // the in-team BAPert spawned by the Electron shell. It runs outside
    // ACP's PTY grid and sends mail in via the /v1/mail/send endpoint.
    this._agents = new Set([
      'DotNetPert', 'BAPert', 'NextPert', 'QAPert', 'Aurum', 'NextPertTwo',
      'BAPert-Jon'
    ]);

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
  }

  async init() {
    // No-op - no external storage needed
    return true;
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

  async listDocuments() {
    return Array.from(this._documents.values());
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
      listDocuments: () => self.listDocuments(),
      getDocument: (id) => self.getDocument(id),
      updateDocument: (id, updates) => self.updateDocument(id, updates),
      deleteDocument: (id) => self.deleteDocument(id),
    };
  }
}
