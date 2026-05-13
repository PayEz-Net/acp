import { Router, type Request, type Response } from 'express';
import { success, error } from '../response.js';
import { config } from '../../config.js';
import { ensureValidToken, forceRefresh } from '../auth/tokenManager.js';
import { signVibeRequest } from '../auth/vibeHmac.js';

const VIBESQL_URL = process.env.VIBESQL_URL || 'http://10.0.0.93:52411';
const VIBESQL_SECRET = process.env.VIBESQL_SECRET || 'ContainersSuperDevSecret';
const PROFILE_PROXY_TIMEOUT_MS = 10_000;

// ─── Cloud profile proxy ───────────────────────────────────────────────────
//
// Legacy `vibe_agents.agents` real table was retired when the
// documents-canonical model landed (per feedback_vibe_storage_convention
// + project_vibe_agents_storage_planes). Profile data now lives in
// vibe.documents agent_profiles collection, exposed via cloud
// /v1/agents/{id}/profile. This handler proxies to cloud and maps the
// snake_case wire shape to the camelCase shape Kimi/Claude
// agent-onboarding skills consume.
//
// Cloud accepts numeric id only on /profile. For name lookups we
// resolve id first via /v1/agentmail/agents and cache the mapping
// for the process lifetime (canonical agent roster rarely changes).

const nameToIdCache = new Map<string, number>();
let nameToIdCachePopulatedAt = 0;
const NAME_TO_ID_TTL_MS = 5 * 60 * 1000; // 5 min — refresh occasionally so new agents resolve

function buildCloudAuthHeaders(token: string, signedPath: string): Record<string, string> {
  const hmacHeaders = signVibeRequest('GET', signedPath, {
    clientId: config.vibeClientId,
    signingKey: config.vibeHmacKey,
  });
  return {
    ...hmacHeaders,
    'Authorization': `Bearer ${token}`,
    'X-Vibe-Via': 'idp-proxy',
    'X-Vibe-User-Id': config.vibeUserId || '0',
    'Content-Type': 'application/json',
  };
}

async function cloudFetch(signedPath: string): Promise<{ status: number; body: any } | { error: string }> {
  let token = await ensureValidToken(config.idpUrl);
  if (!token) return { error: 'NO_SESSION' };

  const url = `${config.vibeApiUrl}${signedPath}`;
  const doFetch = async (bearer: string) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), PROFILE_PROXY_TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        method: 'GET',
        headers: buildCloudAuthHeaders(bearer, signedPath),
        signal: controller.signal,
      });
      const text = await res.text();
      let body: any = null;
      try { body = text ? JSON.parse(text) : null; } catch { /* leave null */ }
      return { status: res.status, body };
    } finally {
      clearTimeout(timeout);
    }
  };

  let attempt = await doFetch(token);
  if (attempt.status === 401) {
    const refreshed = await forceRefresh(config.idpUrl);
    if (!refreshed) return { error: 'NO_SESSION' };
    attempt = await doFetch(refreshed);
  }
  return attempt;
}

async function resolveAgentNameToId(name: string): Promise<number | null> {
  const cached = nameToIdCache.get(name);
  if (cached !== undefined && Date.now() - nameToIdCachePopulatedAt < NAME_TO_ID_TTL_MS) {
    return cached;
  }

  const result = await cloudFetch('/v1/agentmail/agents');
  if ('error' in result) return null;
  if (result.status < 200 || result.status >= 300) return null;
  const agents = result.body?.data?.agents;
  if (!Array.isArray(agents)) return null;

  // Repopulate cache from this fetch — single roundtrip covers all canonical
  // agents, no point caching just the one we asked for.
  nameToIdCache.clear();
  for (const a of agents) {
    if (a && typeof a.id === 'number' && typeof a.name === 'string') {
      nameToIdCache.set(a.name, a.id);
    }
  }
  nameToIdCachePopulatedAt = Date.now();
  return nameToIdCache.get(name) ?? null;
}

interface CloudProfileShape {
  id?: number;
  agent_id?: number;
  identity_md?: string | null;
  role_md?: string | null;
  philosophy_md?: string | null;
  communication_md?: string | null;
  response_pattern_md?: string | null;
  expertise_json?: unknown;
  capabilities?: unknown;
  safety_rules?: unknown;
  version?: number;
}

function mapCloudProfile(
  cloudProfile: CloudProfileShape,
  meta: { name: string; displayName?: string; role?: string },
): Record<string, unknown> {
  // v1 schema collapse (Jon directive 2026-05-12): the 5-field
  // psychological breakdown (identity_md / role_md / philosophy_md /
  // communication_md / response_pattern_md) is OUT for launch. The
  // schema is `properties + one free-text profile`. Users can put
  // whatever attributes they want in the free-text profile.
  //
  // For backward-tolerance during the cloud schema cleanup, we
  // concatenate any non-empty content across the legacy fields into
  // a single `profile` paragraph blob. In practice today only
  // identity_md is populated for canonical agents — so `profile`
  // ends up = identity_md content. Order matches the original
  // breakdown sequence so any author who DID fill multiple fields
  // gets a sensible read.
  const sections = [
    cloudProfile.identity_md,
    cloudProfile.role_md,
    cloudProfile.philosophy_md,
    cloudProfile.communication_md,
    cloudProfile.response_pattern_md,
  ].filter((s): s is string => typeof s === 'string' && s.length > 0);
  const profile = sections.join('\n\n');
  return {
    name: meta.name,
    displayName: meta.displayName || meta.name,
    role: meta.role || 'agent',
    profile,
    isActive: true,
    program: 'claude-code',
    model: 'claude-sonnet-4-6',
  };
}

// ── SQL helpers ────────────────────────────────────────────────────────────

function escapeSql(value: unknown): string {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return 'NULL';
    return String(value);
  }
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  return "'" + String(value).replace(/'/g, "''") + "'";
}

function escapeJsonb(obj: unknown): string {
  return "'" + JSON.stringify(obj).replace(/'/g, "''") + "'::jsonb";
}

function toCamel(str: string): string {
  return str.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
}

function rowToCamel(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    const camelKey = toCamel(k);
    // Parse JSONB string fields back to arrays/objects
    if (
      (camelKey === 'expertiseJson' || camelKey === 'capabilities' || camelKey === 'safetyRules') &&
      typeof v === 'string'
    ) {
      try {
        out[camelKey] = JSON.parse(v);
      } catch {
        out[camelKey] = v;
      }
    } else {
      out[camelKey] = v;
    }
  }
  return out;
}

async function queryVibeSql(sql: string): Promise<{ success: boolean; data?: any[]; rowCount?: number; error?: any }> {
  const res = await fetch(`${VIBESQL_URL}/v1/query`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Secret ${VIBESQL_SECRET}`,
    },
    body: JSON.stringify({ sql }),
  });
  const data = await res.json().catch(() => ({ success: false }));
  return data;
}

// ── JWT helper ─────────────────────────────────────────────────────────────

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const payloadB64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = payloadB64 + '='.repeat((4 - payloadB64.length % 4) % 4);
    return JSON.parse(Buffer.from(padded, 'base64').toString('utf8'));
  } catch {
    return null;
  }
}

function getBearerEmail(req: Request): string | null {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) return null;
  const token = authHeader.slice(7);
  const payload = decodeJwtPayload(token);
  if (payload && typeof payload.email === 'string') return payload.email;
  return null;
}

function getBearerIdentity(req: Request): { email: string | null; sub: string | null; clientId: number | null } {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) return { email: null, sub: null, clientId: null };
  const token = authHeader.slice(7);
  const payload = decodeJwtPayload(token);
  const email = payload && typeof payload.email === 'string' ? payload.email : null;
  const sub = payload && typeof payload.sub === 'string' ? payload.sub : null;
  // Some IDPs put client_id in the JWT as a string or number claim
  const clientIdClaim = payload?.client_id ?? payload?.clientId ?? payload?.tenant;
  const clientId = typeof clientIdClaim === 'number' ? clientIdClaim : typeof clientIdClaim === 'string' ? parseInt(clientIdClaim, 10) || null : null;
  return { email, sub, clientId };
}

// ── Route factory ──────────────────────────────────────────────────────────

export default function agentRoutes(_storage: any): Router {
  const router = Router();

  // GET /v1/agents/startup-config
  router.get('/startup-config', async (req: Request, res: Response) => {
    try {
      const sql = `SELECT id, name, display_name, role, model, expertise_json, agent_type, is_active, startup_order, capabilities, safety_rules
                   FROM vibe_agents.agents
                   WHERE is_active = true AND deleted_at IS NULL
                   ORDER BY startup_order ASC, name ASC`;
      const vsql = await queryVibeSql(sql);
      if (!vsql.success) {
        res.status(500).json(error('INTERNAL_ERROR', vsql.error?.message || 'VibeSQL query failed', 'agent_startup_config', (req as any).requestId));
        return;
      }
      const agents = (vsql.data || []).map(rowToCamel);
      res.json(success({ agents, active_count: agents.length }, 'agent_startup_config', (req as any).requestId));
    } catch (err: any) {
      res.status(500).json(error('INTERNAL_ERROR', err.message, 'agent_startup_config', (req as any).requestId));
    }
  });

  // PATCH /v1/agents/:id/activation
  router.patch('/:id/activation', async (req: Request, res: Response) => {
    try {
      const id = parseInt(req.params.id as string, 10);
      if (isNaN(id)) {
        res.status(400).json(error('VALIDATION_ERROR', 'id must be an integer', 'agent_activation', (req as any).requestId));
        return;
      }

      const { is_active, startup_order } = req.body || {};
      if (is_active === undefined || typeof is_active !== 'boolean') {
        res.status(400).json(error('VALIDATION_ERROR', 'is_active (boolean) is required', 'agent_activation', (req as any).requestId));
        return;
      }

      const sets: string[] = [`is_active = ${escapeSql(is_active)}`];
      if (startup_order !== undefined) {
        const order = parseInt(startup_order, 10);
        if (isNaN(order) || order < 0) {
          res.status(400).json(error('VALIDATION_ERROR', 'startup_order must be a non-negative integer', 'agent_activation', (req as any).requestId));
          return;
        }
        sets.push(`startup_order = ${escapeSql(order)}`);
      }
      sets.push(`updated_at = NOW()`);

      const sql = `UPDATE vibe_agents.agents SET ${sets.join(', ')} WHERE id = ${escapeSql(id)} RETURNING *`;
      const vsql = await queryVibeSql(sql);
      if (!vsql.success || !vsql.data?.length) {
        res.status(404).json(error('AGENT_NOT_FOUND', 'Agent not found', 'agent_activation', (req as any).requestId));
        return;
      }
      res.json(success(rowToCamel(vsql.data[0]), 'agent_activation', (req as any).requestId));
    } catch (err: any) {
      res.status(500).json(error('INTERNAL_ERROR', err.message, 'agent_activation', (req as any).requestId));
    }
  });

  // DELETE /v1/agents/:id — soft delete
  router.delete('/:id', async (req: Request, res: Response) => {
    try {
      const id = parseInt(req.params.id as string, 10);
      if (isNaN(id)) {
        res.status(400).json(error('VALIDATION_ERROR', 'id must be an integer', 'agent_delete', (req as any).requestId));
        return;
      }

      const check = await queryVibeSql(`SELECT id, name FROM vibe_agents.agents WHERE id = ${escapeSql(id)} AND deleted_at IS NULL`);
      if (!check.success || !check.data?.length) {
        res.status(404).json(error('AGENT_NOT_FOUND', 'Agent not found', 'agent_delete', (req as any).requestId));
        return;
      }

      await queryVibeSql(`UPDATE vibe_agents.agents SET is_active = false, deleted_at = NOW(), updated_at = NOW() WHERE id = ${escapeSql(id)}`);
      res.json(success({ id, name: check.data[0].name, deleted: true }, 'agent_delete', (req as any).requestId));
    } catch (err: any) {
      res.status(500).json(error('INTERNAL_ERROR', err.message, 'agent_delete', (req as any).requestId));
    }
  });

  // POST /v1/agents/hire
  router.post('/hire', async (req: Request, res: Response) => {
    try {
      const { name, display_name, template_name, is_active, role, description } = req.body || {};

      if (!name || typeof name !== 'string' || name.trim().length === 0) {
        res.status(400).json(error('VALIDATION_ERROR', 'name is required', 'agent_hire', (req as any).requestId));
        return;
      }
      const trimmedName = name.trim();

      // Check if name already exists (including soft-deleted — unique constraint)
      const existing = await queryVibeSql(`SELECT id FROM vibe_agents.agents WHERE name = ${escapeSql(trimmedName)} AND deleted_at IS NULL`);
      if (existing.success && existing.data?.length) {
        res.status(409).json(error('CONFLICT', 'Agent with that name already exists', 'agent_hire', (req as any).requestId));
        return;
      }

      // Template lookup is optional; if provided and not found, we just use body fields
      let templateData: any = {};
      if (template_name) {
        const pool = await queryVibeSql(
          `SELECT data FROM vibe.documents WHERE client_id = 8 AND collection = 'vibe_agents' AND table_name = 'contractor_pool' ORDER BY data->>'name'`
        );
        if (pool.success && pool.data) {
          const match = pool.data.find((r: any) => {
            const d = typeof r.data === 'string' ? JSON.parse(r.data) : r.data;
            return d?.name === template_name;
          });
          if (match) {
            const d = typeof match.data === 'string' ? JSON.parse(match.data) : match.data;
            templateData = {
              displayName: d.display_name || d.name,
              role: d.description || null,
              model: d.model || null,
              expertiseJson: d.tools_json || {},
            };
          }
        }
      }

      const sql = `INSERT INTO vibe_agents.agents
        (name, display_name, role, model, expertise_json, agent_type, is_active, capabilities, safety_rules)
        VALUES (
          ${escapeSql(trimmedName)},
          ${escapeSql(display_name || templateData.displayName || trimmedName)},
          ${escapeSql(role || description || templateData.role || null)},
          ${escapeSql(templateData.model || null)},
          ${escapeJsonb(templateData.expertiseJson || {})},
          ${escapeSql(is_active ? 'team' : 'contractor')},
          ${escapeSql(is_active !== undefined ? is_active : false)},
          '{}'::jsonb,
          '[]'::jsonb
        )
        RETURNING *`;
      const vsql = await queryVibeSql(sql);
      if (!vsql.success || !vsql.data?.length) {
        res.status(500).json(error('INTERNAL_ERROR', vsql.error?.message || 'Insert failed', 'agent_hire', (req as any).requestId));
        return;
      }
      res.status(201).json(success(rowToCamel(vsql.data[0]), 'agent_hire', (req as any).requestId));
    } catch (err: any) {
      res.status(500).json(error('INTERNAL_ERROR', err.message, 'agent_hire', (req as any).requestId));
    }
  });

  // PUT /v1/agents/startup-order
  router.put('/startup-order', async (req: Request, res: Response) => {
    try {
      const { order } = req.body || {};
      if (!Array.isArray(order) || order.length === 0) {
        res.status(400).json(error('VALIDATION_ERROR', 'order must be a non-empty array of { agent_id, startup_order }', 'agent_startup_order', (req as any).requestId));
        return;
      }

      for (const entry of order) {
        if (!entry.agent_id || isNaN(parseInt(entry.agent_id, 10))) {
          res.status(400).json(error('VALIDATION_ERROR', 'Each entry must have a valid agent_id', 'agent_startup_order', (req as any).requestId));
          return;
        }
        const so = parseInt(entry.startup_order, 10);
        if (isNaN(so) || so < 0) {
          res.status(400).json(error('VALIDATION_ERROR', 'Each entry must have a non-negative startup_order', 'agent_startup_order', (req as any).requestId));
          return;
        }
      }

      const updates = order.map((entry: any) =>
        `UPDATE vibe_agents.agents SET startup_order = ${escapeSql(parseInt(entry.startup_order, 10))}, updated_at = NOW() WHERE id = ${escapeSql(parseInt(entry.agent_id, 10))};`
      ).join('\n');

      const vsql = await queryVibeSql(`DO $$ BEGIN ${updates} END $$`);
      if (!vsql.success) {
        res.status(500).json(error('INTERNAL_ERROR', vsql.error?.message || 'Startup order update failed', 'agent_startup_order', (req as any).requestId));
        return;
      }
      res.json(success({ updated: order.length }, 'agent_startup_order', (req as any).requestId));
    } catch (err: any) {
      res.status(500).json(error('INTERNAL_ERROR', err.message, 'agent_startup_order', (req as any).requestId));
    }
  });

  // PUT /v1/agents/:id/capabilities
  router.put('/:id/capabilities', async (req: Request, res: Response) => {
    try {
      const id = parseInt(req.params.id as string, 10);
      if (isNaN(id)) {
        res.status(400).json(error('VALIDATION_ERROR', 'id must be an integer', 'agent_capabilities', (req as any).requestId));
        return;
      }
      const { capabilities } = req.body || {};
      if (!capabilities || typeof capabilities !== 'object' || Array.isArray(capabilities)) {
        res.status(400).json(error('VALIDATION_ERROR', 'capabilities must be an object', 'agent_capabilities', (req as any).requestId));
        return;
      }

      const sql = `UPDATE vibe_agents.agents SET capabilities = ${escapeJsonb(capabilities)}, updated_at = NOW() WHERE id = ${escapeSql(id)} RETURNING *`;
      const vsql = await queryVibeSql(sql);
      if (!vsql.success || !vsql.data?.length) {
        res.status(404).json(error('AGENT_NOT_FOUND', 'Agent not found', 'agent_capabilities', (req as any).requestId));
        return;
      }
      res.json(success(rowToCamel(vsql.data[0]), 'agent_capabilities', (req as any).requestId));
    } catch (err: any) {
      res.status(500).json(error('INTERNAL_ERROR', err.message, 'agent_capabilities', (req as any).requestId));
    }
  });

  // PUT /v1/agents/:id/safety-rules
  router.put('/:id/safety-rules', async (req: Request, res: Response) => {
    try {
      const id = parseInt(req.params.id as string, 10);
      if (isNaN(id)) {
        res.status(400).json(error('VALIDATION_ERROR', 'id must be an integer', 'agent_safety_rules', (req as any).requestId));
        return;
      }
      const { safety_rules } = req.body || {};
      if (!Array.isArray(safety_rules)) {
        res.status(400).json(error('VALIDATION_ERROR', 'safety_rules must be an array', 'agent_safety_rules', (req as any).requestId));
        return;
      }

      const sql = `UPDATE vibe_agents.agents SET safety_rules = ${escapeJsonb(safety_rules)}, updated_at = NOW() WHERE id = ${escapeSql(id)} RETURNING *`;
      const vsql = await queryVibeSql(sql);
      if (!vsql.success || !vsql.data?.length) {
        res.status(404).json(error('AGENT_NOT_FOUND', 'Agent not found', 'agent_safety_rules', (req as any).requestId));
        return;
      }
      res.json(success(rowToCamel(vsql.data[0]), 'agent_safety_rules', (req as any).requestId));
    } catch (err: any) {
      res.status(500).json(error('INTERNAL_ERROR', err.message, 'agent_safety_rules', (req as any).requestId));
    }
  });

  // POST /v1/agents/init-project
  router.post('/init-project', async (req: Request, res: Response) => {
    try {
      const identity = getBearerIdentity(req);
      const email = identity.email;
      const userId = identity.sub ? parseInt(identity.sub, 10) : null;
      const clientId = identity.clientId ?? parseInt(process.env.VIBE_CLIENT_ID || '8', 10);
      const { project_name } = req.body || {};

      let derivedName = project_name;
      if (!derivedName) {
        if (!email) {
          res.status(400).json(error('EMAIL_REQUIRED', 'Session JWT has no email claim — provide project_name override', 'agent_init_project', (req as any).requestId));
          return;
        }
        const localPart = email.split('@')[0].toLowerCase();
        derivedName = `${localPart}-project`;
      }

      // Check for existing project in vibe_projects.projects (unified with frontend)
      const existingProject = await queryVibeSql(
        `SELECT id, name FROM vibe_projects.projects WHERE name = ${escapeSql(derivedName)} AND deleted_at IS NULL LIMIT 1`
      );

      let projectId: number;
      let isNewlyCreated = false;

      if (existingProject.success && existingProject.data?.length) {
        projectId = existingProject.data[0].id;
      } else {
        const createProject = await queryVibeSql(
          `INSERT INTO vibe_projects.projects (name, description, is_active, client_id, created_by, updated_by)
           VALUES (${escapeSql(derivedName)}, ${escapeSql('Auto-provisioned project')}, true, ${escapeSql(clientId)}, ${escapeSql(userId)}, ${escapeSql(userId)})
           RETURNING id`
        );
        if (!createProject.success || !createProject.data?.length) {
          res.status(500).json(error('INTERNAL_ERROR', createProject.error?.message || 'Project creation failed', 'agent_init_project', (req as any).requestId));
          return;
        }
        projectId = createProject.data[0].id;
        isNewlyCreated = true;
      }

      // Ensure 2 default agents exist in vibe_agents.agents (universal pair)
      const defaultAgents = [
        { name: 'BAPert', display_name: 'Business Analyst and Product Strategist', role: 'team-lead' },
        { name: 'QAPert', display_name: 'QA Analyst Specialist', role: 'qa-analyst' },
      ];

      const agentsCreated: Array<{ id: number; name: string; display_name: string }> = [];
      for (const agent of defaultAgents) {
        const check = await queryVibeSql(
          `SELECT id, name, display_name FROM vibe_agents.agents WHERE name = ${escapeSql(agent.name)} AND deleted_at IS NULL`
        );
        if (check.success && check.data?.length) {
          agentsCreated.push({ id: check.data[0].id, name: check.data[0].name, display_name: check.data[0].display_name });
        } else {
          const insert = await queryVibeSql(
            `INSERT INTO vibe_agents.agents (name, display_name, role, is_active, capabilities, safety_rules, updated_at)
             VALUES (${escapeSql(agent.name)}, ${escapeSql(agent.display_name)}, ${escapeSql(agent.role)}, true, '{}'::jsonb, '[]'::jsonb, NOW())
             RETURNING id, name, display_name`
          );
          if (insert.success && insert.data?.length) {
            agentsCreated.push({ id: insert.data[0].id, name: insert.data[0].name, display_name: insert.data[0].display_name });
          }
        }
      }

      const payload = {
        project_id: projectId,
        project_name: derivedName,
        agents_created: agentsCreated.length,
        agents: agentsCreated.map(a => ({ id: a.id, name: a.name, display_name: a.display_name })),
        isNewlyCreated,
      };

      res.status(isNewlyCreated ? 201 : 200).json(success(payload, 'agent_init_project', (req as any).requestId));
    } catch (err: any) {
      res.status(500).json(error('INTERNAL_ERROR', err.message, 'agent_init_project', (req as any).requestId));
    }
  });

  // GET /v1/agents/:identifier/profile — proxies to cloud agent profile
  // doc-store (post-2026-05-12 cloud-canonical refactor).
  //
  // identifier: numeric id  → direct proxy to cloud /v1/agents/{id}/profile
  // identifier: name        → resolve name→id via cloud /v1/agentmail/agents,
  //                           then proxy
  //
  // The legacy vibe_agents.agents real table was retired with the
  // documents-canonical migration. Direct VibeSQL queries against it
  // returned `relation "vibe_agents.agents" does not exist` and the
  // handler dropped to a thin-shape fallback that broke the Kimi
  // agent-onboarding skill. Cloud has the canonical doc-store data
  // and accepts numeric id on /profile.
  router.get('/:identifier/profile', async (req: Request, res: Response) => {
    try {
      const identifier = req.params.identifier;
      if (!identifier || typeof identifier !== 'string') {
        res.status(400).json(error('VALIDATION_ERROR', 'identifier is required', 'agent_profile', (req as any).requestId));
        return;
      }

      const isNumericId = /^\d+$/.test(identifier);
      let agentId: number | null = null;
      let resolvedName = '';

      if (isNumericId) {
        agentId = parseInt(identifier, 10);
        // We don't have the name yet; lookup via cache or roster after we
        // fetch the profile. Cheaper to just include it in the mapper
        // fallback as "<id>" if roster lookup misses.
      } else {
        resolvedName = identifier;
        agentId = await resolveAgentNameToId(identifier);
        if (agentId === null) {
          console.warn(`[agent_profile] Could not resolve name "${identifier}" to id via cloud /v1/agentmail/agents — falling back to SessionManager thin shape`);
          const basic = await _storage.getAgentProfileFromGlobal(identifier);
          if (basic) {
            res.json(success(basic, 'agent_profile', (req as any).requestId));
            return;
          }
          res.status(404).json(error('NOT_FOUND', `Agent '${identifier}' not found`, 'agent_profile', (req as any).requestId));
          return;
        }
      }

      // Pull the agent metadata (name + display_name) from the cached
      // roster so the response carries the right name/display_name even
      // when only the id was on the wire.
      let displayName: string | undefined;
      if (!resolvedName && agentId !== null) {
        for (const [n, id] of nameToIdCache.entries()) {
          if (id === agentId) { resolvedName = n; break; }
        }
        if (!resolvedName) {
          // Populate the cache by force-fetching the roster.
          await resolveAgentNameToId('___populate-only___');
          for (const [n, id] of nameToIdCache.entries()) {
            if (id === agentId) { resolvedName = n; break; }
          }
        }
      }

      const profileResult = await cloudFetch(`/v1/agents/${agentId}/profile`);
      if ('error' in profileResult) {
        console.warn(`[agent_profile] Cloud unreachable for /v1/agents/${agentId}/profile (${profileResult.error}) — thin fallback`);
        const basic = await _storage.getAgentProfileFromGlobal(resolvedName || String(agentId));
        if (basic) {
          res.json(success(basic, 'agent_profile', (req as any).requestId));
          return;
        }
        res.status(503).json(error('UPSTREAM_UNAVAILABLE', `Cloud unreachable: ${profileResult.error}`, 'agent_profile', (req as any).requestId));
        return;
      }

      if (profileResult.status === 404) {
        res.status(404).json(error('NOT_FOUND', `Agent '${identifier}' not found in cloud doc-store`, 'agent_profile', (req as any).requestId));
        return;
      }

      if (profileResult.status < 200 || profileResult.status >= 300) {
        console.warn(`[agent_profile] Cloud returned HTTP ${profileResult.status} for agent ${agentId} — thin fallback`);
        const basic = await _storage.getAgentProfileFromGlobal(resolvedName || String(agentId));
        if (basic) {
          res.json(success(basic, 'agent_profile', (req as any).requestId));
          return;
        }
        res.status(profileResult.status).json(error('UPSTREAM_ERROR', `Cloud returned HTTP ${profileResult.status}`, 'agent_profile', (req as any).requestId));
        return;
      }

      const cloudProfile: CloudProfileShape | undefined = profileResult.body?.data?.profile;
      const responseAgentName: string | undefined = profileResult.body?.data?.agent_name;
      if (!cloudProfile) {
        console.warn(`[agent_profile] Cloud response missing data.profile for agent ${agentId} — thin fallback`);
        const basic = await _storage.getAgentProfileFromGlobal(resolvedName || String(agentId));
        if (basic) {
          res.json(success(basic, 'agent_profile', (req as any).requestId));
          return;
        }
        res.status(502).json(error('UPSTREAM_BAD_SHAPE', 'Cloud response missing profile data', 'agent_profile', (req as any).requestId));
        return;
      }

      const profile = mapCloudProfile(cloudProfile, {
        name: resolvedName || responseAgentName || String(agentId),
        displayName: displayName,
      });

      res.json(success(profile, 'agent_profile', (req as any).requestId));
    } catch (err: any) {
      res.status(500).json(error('INTERNAL_ERROR', err.message, 'agent_profile', (req as any).requestId));
    }
  });

  return router;
}
