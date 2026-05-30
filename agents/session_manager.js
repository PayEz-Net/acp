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

    // Seed Stripe documentation for agent queries
    const stripeDocs = [
      {
        title: 'Stripe Integration — Agent Reference',
        content_md: `# Stripe Integration — Agent Reference\n\n**Scope:** IdealResume / IdealVibe checkout, billing, and subscription flow.\n**Backend:** PayEz-Core Stripe services + AKS.\n**Frontend:** idealvibe.online Next.js checkout components.\n\n## Quick Links\n\n| Doc | Purpose |\n|---|---|\n| configuration.md | Keys, price IDs, AKS configmaps/secrets |\n| testing-checklist.md | Pre-release validation steps |\n| live-mode-checklist.md | Switching from test to production |\n\n## Architecture\n\nidealvibe.online (Next.js checkout) -> PayEz.Stripe.Api (AKS, .NET) -> Stripe.com (live/test)\n\n## Environments\n\n| Env | Stripe Mode | Account |\n|---|---|---|\n| Production | Live | acct_1SUtxaLZTjUNa0XI (activate for live) |\n| Beta | Test | Same sandbox |\n\n## Key Files\n\n- PayEz-Core/AKS/configmaps/idealresume-config.yaml — publishable key + price IDs\n- PayEz-Core/AKS/secrets/idealresume-secrets.yaml — secret key + webhook secret\n- idealvibe.online/azure-pipelines.yml — build pipeline\n- idealvibe.online/Dockerfile — container build\n- idealvibe.online/app/checkout/components/CreditCardForm.tsx — Stripe Elements loader\n\n## Current Status\n\n- Test mode: Active. All price IDs are test IDs.\n- Live mode: Not yet activated. Placeholder values in secrets YAML.\n- Build-time issue: NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY is not passed as Docker build-arg. Next.js inlines it at build time — runtime ConfigMap changes do not affect it without a rebuild.\n`,
        type: 'stripe',
        version: '1.0',
      },
      {
        title: 'Stripe Configuration Reference',
        content_md: `# Stripe Configuration Reference\n\n## AKS ConfigMap — idealresume-config\n\n| Key | Current Value | Type |\n|---|---|---|\n| NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY | pk_test_51SUtxaLZTjUNa0XI... | Build-time |\n| STRIPE_PRICE_PREMIUM | price_1ScMiKANFKV4tLacE1XStJSA | Runtime |\n| STRIPE_PRICE_PREMIUM_ANNUAL | price_1ScMiKANFKV4tLacCuBbUuyH | Runtime |\n| STRIPE_PRICE_ULTIMATE | price_1ScMnqANFKV4tLacxwa8MeLd | Runtime |\n| STRIPE_PRICE_ULTIMATE_ANNUAL | price_1ScMnqANFKV4tLac3E7sCRH1 | Runtime |\n\nBuild-time warning: NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY is inlined by Next.js at docker build time. Changing it in the ConfigMap without a rebuild has no effect.\n\n## AKS Secrets — idealresume-secrets\n\n| Key | Current Value | Notes |\n|---|---|---|\n| STRIPE_SECRET_KEY | sk_live_your_stripe_secret_key_here | PLACEHOLDER |\n| STRIPE_WEBHOOK_SECRET | whsec_your_webhook_secret_here | PLACEHOLDER |\n\n## Tier-to-Price Mapping\n\n| Tier | Credits/Month | ConfigMap Key |\n|---|---|---|\n| Premium Monthly | 30 | STRIPE_PRICE_PREMIUM |\n| Premium Annual | 30 | STRIPE_PRICE_PREMIUM_ANNUAL |\n| Ultimate Monthly | 100 | STRIPE_PRICE_ULTIMATE |\n| Ultimate Annual | 100 | STRIPE_PRICE_ULTIMATE_ANNUAL |\n| Enterprise Monthly | 500 | PLACEHOLDER |\n\n## Known Placeholders\n\n1. STRIPE_PRICE_ENTERPRISE — no real price ID exists yet.\n2. STRIPE_SECRET_KEY in secrets YAML — placeholder.\n3. STRIPE_WEBHOOK_SECRET in secrets YAML — placeholder.\n`,
        type: 'stripe',
        version: '1.0',
      },
      {
        title: 'Stripe Testing Checklist',
        content_md: `# Stripe Testing Checklist\n\nRun this before any production release.\n\n## Pre-Test Setup\n\n- [ ] Stripe test API key configured (sk_test_...)\n- [ ] Stripe webhook secret configured (whsec_...)\n- [ ] Stripe CLI installed for local webhook forwarding\n- [ ] Test products/prices created in Stripe dashboard\n- [ ] Database migrations applied (tier_configurations, stripe_webhook_events)\n\n## Checkout Flow\n\n- [ ] Unauthenticated user redirected to login before checkout\n- [ ] Premium monthly checkout creates session and redirects to Stripe\n- [ ] Premium annual checkout works\n- [ ] Ultimate monthly checkout works\n- [ ] Ultimate annual checkout works\n- [ ] Success redirect lands on /payment/success\n- [ ] Cancel redirect returns to /pricing\n- [ ] Stripe test card 4242424242424242 processes successfully\n\n## Webhook Processing\n\n- [ ] checkout.session.completed -> credits allocated\n- [ ] customer.subscription.created -> tier updated\n- [ ] customer.subscription.updated -> tier changes reflected\n- [ ] customer.subscription.deleted -> free tier downgrade\n- [ ] payment_intent.payment_failed -> logged in /admin/billing-issues\n- [ ] Duplicate webhooks idempotent (same event_id ignored)\n- [ ] Invalid webhook signature returns 400\n\n## Credit Allocation\n\n- [ ] Premium: 30 credits\n- [ ] Ultimate: 100 credits\n- [ ] Enterprise: 500 credits\n- [ ] No double-allocation on duplicate webhooks\n\n## Edge Cases\n\n- [ ] Expired card handling\n- [ ] User with no Stripe customer ID attempts checkout\n- [ ] Webhook received before checkout session completed\n- [ ] Multiple rapid webhook deliveries (idempotency)\n- [ ] Stripe API timeout during checkout session creation\n`,
        type: 'stripe',
        version: '1.0',
      },
      {
        title: 'Stripe Live Mode Checklist',
        content_md: `# Stripe Live Mode Checklist\n\nSwitching IdealResume from Stripe test/sandbox to production.\n\n> Account: Current sandbox is acct_1SUtxaLZTjUNa0XI. You need a live Stripe account.\n\n## Step 1 — Stripe Dashboard Setup\n\n- [ ] Activate live mode on Stripe account\n- [ ] Create live Products for each plan (Premium Monthly/Annual, Ultimate Monthly/Annual, Enterprise Monthly)\n- [ ] Copy live Price IDs from Stripe Dashboard\n\n## Step 2 — Update AKS Secrets\n\nFile: PayEz-Core/AKS/secrets/idealresume-secrets.yaml\n\nSTRIPE_SECRET_KEY: sk_live_...\nSTRIPE_WEBHOOK_SECRET: whsec_...\n\nApply: kubectl apply -f PayEz-Core/AKS/secrets/idealresume-secrets.yaml\n\n## Step 3 — Update AKS ConfigMap\n\nFile: PayEz-Core/AKS/configmaps/idealresume-config.yaml\n\nNEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: pk_live_...\nSTRIPE_PRICE_PREMIUM: price_live_...\nSTRIPE_PRICE_PREMIUM_ANNUAL: price_live_...\nSTRIPE_PRICE_ULTIMATE: price_live_...\nSTRIPE_PRICE_ULTIMATE_ANNUAL: price_live_...\n\nApply: kubectl apply -f PayEz-Core/AKS/configmaps/idealresume-config.yaml\n\n## Step 4 — Build-Time Fix (Critical)\n\nNEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY is inlined by Next.js at build time. Current Dockerfile and azure-pipelines.yml do NOT pass it as a build arg.\n\n### Option A — Add build arg to pipeline (recommended)\n\nUpdate idealvibe.online/azure-pipelines.yml:\n  docker build --build-arg NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=$(STRIPE_PUBLISHABLE_KEY) ...\n\nUpdate idealvibe.online/Dockerfile:\n  ARG NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY\n  ENV NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=$NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY\n\nAdd pipeline variable STRIPE_PUBLISHABLE_KEY in Azure DevOps.\n\n### Option B — Update .env.production\n\nChange idealvibe.online/.env.production: NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=pk_live_...\nCommit, push, rebuild. Less secure — live key in git.\n\n## Step 5 — Live Webhook Endpoint\n\nIn Stripe Dashboard:\n- [ ] Create webhook endpoint: https://idealresume.online/api/stripe/webhook\n- [ ] Subscribe to events: checkout.session.completed, customer.subscription.*, charge.refunded, payment_intent.*, invoice.payment_succeeded\n- [ ] Copy signing secret to STRIPE_WEBHOOK_SECRET\n\n## Step 6 — Deploy\n\nkubectl rollout restart deployment/idealresume -n external-services\n\n## Step 7 — Post-Deploy Validation\n\n- [ ] Run testing-checklist with a real card\n- [ ] Verify webhook events process correctly\n- [ ] Check /admin/billing-issues for failures\n- [ ] Confirm credits allocate correctly\n\n## Rollback Plan\n\n1. Revert secrets to test keys\n2. Revert configmap to test price IDs\n3. Rebuild with test publishable key (if build-time was changed)\n4. kubectl rollout restart deployment/idealresume\n`,
        type: 'stripe',
        version: '1.0',
      },
    ];
    for (const doc of stripeDocs) {
      const id = this._nextDocumentId++;
      this._documents.set(id, {
        id,
        title: doc.title,
        content_md: doc.content_md,
        type: doc.type,
        version: doc.version,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });
    }

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
      created_at: row.created_at,
      updatedAt: row.updated_at,
      completedAt: row.completed_at,
    };
  }

  async createTask(task) {
    const now = new Date().toISOString();
    const sql = `INSERT INTO vibe.kanban_tasks (title, description, status, priority, assigned_to, created_by, spec_path, milestone, files_changed, blockers, created_at, updated_at, completed_at) VALUES (${this._escapeSql(task.title)}, ${this._escapeSql(task.description)}, ${this._escapeSql(task.status || 'backlog')}, ${this._escapeSql(task.priority || 'medium')}, ${this._escapeSql(task.assignedTo)}, ${this._escapeSql(task.createdBy)}, ${this._escapeSql(task.specPath)}, ${this._escapeSql(task.milestone)}, ${this._escapeSql(JSON.stringify(task.filesChanged || []))}::jsonb, ${this._escapeSql(task.blockers)}, ${this._escapeSql(now)}, ${this._escapeSql(now)}, NULL) RETURNING id`;
    const result = await this._queryVibeSql(sql);
    if (!result.success || !result.data || result.data.length === 0) {
      throw new Error(result.error?.message || 'Failed to create kanban task');
    }
    return result.data[0].id;
  }

  async getTask(id) {
    const sql = `SELECT * FROM vibe.kanban_tasks WHERE id = ${Number(id)}`;
    const result = await this._queryVibeSql(sql);
    if (!result.success || !result.data || result.data.length === 0) return null;
    return this._rowToTask(result.data[0]);
  }

  async listTasks(filter = {}) {
    let sql = 'SELECT * FROM vibe.kanban_tasks WHERE 1=1';
    // #152: archived (soft-deleted) tasks are EXCLUDED from the default board. Pass
    // archived=true for the archived view, or includeArchived=true to see both.
    if (filter.archived === true) {
      sql += ' AND archived IS TRUE';
    } else if (!filter.includeArchived) {
      sql += ' AND archived IS NOT TRUE';
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
    if (!result.success || !result.data) return [];
    return result.data.map(r => this._rowToTask(r));
  }

  async updateTask(id, updates) {
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
    if (updates.archived !== undefined) sets.push(`archived = ${this._escapeSql(!!updates.archived)}`);
    if (sets.length === 0) return this.getTask(id);
    const sql = `UPDATE vibe.kanban_tasks SET ${sets.join(', ')} WHERE id = ${Number(id)} RETURNING *`;
    const result = await this._queryVibeSql(sql);
    if (!result.success || !result.data || result.data.length === 0) return null;
    return this._rowToTask(result.data[0]);
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
      // Kanban tasks — forwards to the in-memory Phase 1 stub above.
      createTask: (data) => self.createTask(data),
      getTask: (id) => self.getTask(id),
      listTasks: (filter) => self.listTasks(filter),
      updateTask: (id, updates) => self.updateTask(id, updates),
      // Autonomy state + standup entries — forwards to the stubs above.
      getAutonomyState: () => self.getAutonomyState(),
      updateAutonomyState: (partial) => self.updateAutonomyState(partial),
      createStandupEntry: (entry) => self.createStandupEntry(entry),
      listStandupEntries: (filter) => self.listStandupEntries(filter),
    };
  }
}
