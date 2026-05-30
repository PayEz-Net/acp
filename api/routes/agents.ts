import { Router, type Request, type Response } from 'express';
import { success, error } from '../response.js';
import { config } from '../../config.js';
import { ensureValidToken, forceRefresh } from '../auth/tokenManager.js';

import { fileURLToPath } from 'url';
import * as path from 'path';
import * as fs from 'fs';

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

// Decision-C: Bearer-only (no Vibe HMAC secret in the user-session build).
function buildCloudAuthHeaders(token: string): Record<string, string> {
  return {
    'Authorization': `Bearer ${token}`,
    'X-Client-Id': String(config.vibeIdealVibeClientNum),
    'X-Vibe-Via': 'idp-proxy',
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
        headers: buildCloudAuthHeaders(bearer),
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
  identity_md?: string | null;       // ProfileDto [JsonPropertyName("identity_md")]
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
  //
  // Canonical model: type-aware seeding (BAPert ratified 2026-05-23, #37).
  // The doc-store at client_id=0 holds the global Specialist Library catalog.
  // Core team (BA+QA) are always-on; tech specialists are stack-gated via
  // SeedTypeAwareForProjectAsync in vibe-publicapi. is_canonical is deprecated.
  //
  router.get('/startup-config', async (req: Request, res: Response) => {
    try {
      const sql = `SELECT
        (data->>'id')::int AS id,
        data->>'slug' AS name,
        data->>'name' AS display_name,
        data->>'description' AS description,
        data->>'role_preset' AS role,
        data->>'model_hint' AS model,
        data->>'expertise_tags' AS expertise_json,
        data->>'identity_prompt' AS base_prompt,
        COALESCE((data->>'is_active')::boolean, true) AS is_active,
        COALESCE((data->>'is_canonical')::boolean, false) AS is_canonical,
        COALESCE((data->>'is_coordinator')::boolean, false) AS is_coordinator,
        COALESCE((data->>'is_shared')::boolean, false) AS is_shared,
        COALESCE((data->>'startup_order')::int, 0) AS startup_order
      FROM vibe.documents
      WHERE client_id = 0
        AND collection = 'vibe_agents'
        AND table_name = 'agent_profiles'
        AND COALESCE((data->>'is_active')::boolean, true) = true
        AND data->>'deleted_at' IS NULL
      ORDER BY COALESCE((data->>'startup_order')::int, 0) ASC, data->>'name' ASC`;
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

      const patchObj: Record<string, any> = {};
      patchObj.is_active = is_active;
      if (startup_order !== undefined) {
        const order = parseInt(startup_order, 10);
        if (isNaN(order) || order < 0) {
          res.status(400).json(error('VALIDATION_ERROR', 'startup_order must be a non-negative integer', 'agent_activation', (req as any).requestId));
          return;
        }
        patchObj.startup_order = order;
      }
      const patchJson = escapeJsonb(patchObj);

      const sql = `UPDATE vibe.documents SET data = data || ${patchJson}, updated_at = NOW() WHERE client_id = 0 AND collection = 'vibe_agents' AND table_name = 'agent_profiles' AND data->>'id' = ${escapeSql(String(id))} AND deleted_at IS NULL RETURNING document_id, data`;
      const vsql = await queryVibeSql(sql);
      if (!vsql.success || !vsql.data?.length) {
        res.status(404).json(error('AGENT_NOT_FOUND', 'Agent not found', 'agent_activation', (req as any).requestId));
        return;
      }
      const rowData = vsql.data[0];
      const data = typeof rowData.data === 'string' ? JSON.parse(rowData.data) : rowData.data;
      res.json(success({
        id: data.id ?? rowData.document_id,
        name: data.name,
        displayName: data.display_name,
        isActive: data.is_active,
        startupOrder: data.startup_order,
        updatedAt: new Date().toISOString(),
      }, 'agent_activation', (req as any).requestId));
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

      const check = await queryVibeSql(`SELECT document_id, data FROM vibe.documents WHERE client_id = 0 AND collection = 'vibe_agents' AND table_name = 'agent_profiles' AND data->>'id' = ${escapeSql(String(id))} AND deleted_at IS NULL`);
      if (!check.success || !check.data?.length) {
        res.status(404).json(error('AGENT_NOT_FOUND', 'Agent not found', 'agent_delete', (req as any).requestId));
        return;
      }
      const rowData = check.data[0];
      const data = typeof rowData.data === 'string' ? JSON.parse(rowData.data) : rowData.data;

      await queryVibeSql(`UPDATE vibe.documents SET deleted_at = NOW(), updated_at = NOW() WHERE client_id = 0 AND collection = 'vibe_agents' AND table_name = 'agent_profiles' AND data->>'id' = ${escapeSql(String(id))}`);
      res.json(success({ id, name: data.name, deleted: true }, 'agent_delete', (req as any).requestId));
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

      // Check if name already exists in the canonical docstore
      const existing = await queryVibeSql(
        `SELECT document_id FROM vibe.documents
         WHERE client_id = 0 AND collection = 'vibe_agents' AND table_name = 'agent_profiles'
           AND data->>'name' = ${escapeSql(trimmedName)} AND deleted_at IS NULL`
      );
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

      // Allocate next agent id from the docstore JSON ids.
      // INTENTIONALLY UNSCOPED (no client_id filter): the agent-id space is GLOBAL across
      // tenants, not per-client — client_id=0 holds 100-260, client_id=9 continues 261-263 as
      // ONE sequence. So next-id MUST be the global MAX+1 to stay globally unique; scoping to
      // client_id=0 here would collide (260->261, which client_9 already has). 'No client_id
      // filter' is correct, not a missing-WHERE (#124 sweep, verified domain). [Known smell,
      // tracked separately: MAX(id)+1 is race-prone; replace with a global sequence.]
      const nextIdResult = await queryVibeSql(
        `SELECT COALESCE(MAX((data->>'id')::int), 0) + 1 AS next_id
         FROM vibe.documents
         WHERE collection = 'vibe_agents' AND table_name = 'agent_profiles'`
      );
      const nextId = nextIdResult.success && nextIdResult.data?.length ? nextIdResult.data[0].next_id : 1;

      const agentJson = escapeJsonb({
        id: nextId,
        name: trimmedName,
        display_name: display_name || templateData.displayName || trimmedName,
        role: role || description || templateData.role || null,
        model: templateData.model || null,
        agent_type: is_active ? 'team' : 'contractor',
        is_active: is_active !== undefined ? is_active : false,
        is_shared: false,
        program: 'claude-code',
        expertise_tags: templateData.expertiseJson || [],
        capabilities: {},
        safety_rules: [],
        identity_prompt: `I am ${trimmedName}, a specialist agent.`,
        created_at: new Date().toISOString(),
      });

      const insert = await queryVibeSql(
        `INSERT INTO vibe.documents (client_id, user_id, collection, table_name, data, created_at, created_by)
         VALUES (0, NULL, 'vibe_agents', 'agent_profiles', ${agentJson}, CURRENT_TIMESTAMP, 0)
         RETURNING document_id, data`
      );
      if (!insert.success || !insert.data?.length) {
        res.status(500).json(error('INTERNAL_ERROR', insert.error?.message || 'Insert failed', 'agent_hire', (req as any).requestId));
        return;
      }
      const rowData = insert.data[0];
      const data = typeof rowData.data === 'string' ? JSON.parse(rowData.data) : rowData.data;
      res.status(201).json(success({
        id: data.id ?? rowData.document_id,
        name: data.name,
        displayName: data.display_name,
        role: data.role,
        model: data.model,
        agentType: data.agent_type,
        isActive: data.is_active,
        isShared: data.is_shared,
        program: data.program,
        expertiseTags: data.expertise_tags,
        createdAt: data.created_at,
      }, 'agent_hire', (req as any).requestId));
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

      const updates = order.map((entry: any) => {
        const patch = escapeJsonb({ startup_order: parseInt(entry.startup_order, 10) });
        return `UPDATE vibe.documents SET data = data || ${patch}, updated_at = NOW() WHERE client_id = 0 AND collection = 'vibe_agents' AND table_name = 'agent_profiles' AND data->>'id' = ${escapeSql(String(parseInt(entry.agent_id, 10)))} AND deleted_at IS NULL;`;
      }).join('\n');

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

      const patch = escapeJsonb({ capabilities });
      const sql = `UPDATE vibe.documents SET data = data || ${patch}, updated_at = NOW() WHERE client_id = 0 AND collection = 'vibe_agents' AND table_name = 'agent_profiles' AND data->>'id' = ${escapeSql(String(id))} AND deleted_at IS NULL RETURNING document_id, data`;
      const vsql = await queryVibeSql(sql);
      if (!vsql.success || !vsql.data?.length) {
        res.status(404).json(error('AGENT_NOT_FOUND', 'Agent not found', 'agent_capabilities', (req as any).requestId));
        return;
      }
      const rowData = vsql.data[0];
      const data = typeof rowData.data === 'string' ? JSON.parse(rowData.data) : rowData.data;
      res.json(success({
        id: data.id ?? rowData.document_id,
        name: data.name,
        displayName: data.display_name,
        capabilities: data.capabilities,
        updatedAt: new Date().toISOString(),
      }, 'agent_capabilities', (req as any).requestId));
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

      const patch = escapeJsonb({ safety_rules });
      const sql = `UPDATE vibe.documents SET data = data || ${patch}, updated_at = NOW() WHERE client_id = 0 AND collection = 'vibe_agents' AND table_name = 'agent_profiles' AND data->>'id' = ${escapeSql(String(id))} AND deleted_at IS NULL RETURNING document_id, data`;
      const vsql = await queryVibeSql(sql);
      if (!vsql.success || !vsql.data?.length) {
        res.status(404).json(error('AGENT_NOT_FOUND', 'Agent not found', 'agent_safety_rules', (req as any).requestId));
        return;
      }
      const rowData = vsql.data[0];
      const data = typeof rowData.data === 'string' ? JSON.parse(rowData.data) : rowData.data;
      res.json(success({
        id: data.id ?? rowData.document_id,
        name: data.name,
        displayName: data.display_name,
        safetyRules: data.safety_rules,
        updatedAt: new Date().toISOString(),
      }, 'agent_safety_rules', (req as any).requestId));
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
      // Decision-C / no-unjustified-fallback: the tenant MUST come from the session
      // JWT's client_id claim — never default to a baked client number (that silently
      // provisions the project under the wrong tenant). Absent claim -> hard 401.
      const clientId = identity.clientId;
      if (clientId == null) {
        res.status(401).json(error('CLIENT_REQUIRED', 'Session JWT has no client_id (tenant) claim — cannot provision a project', 'agent_init_project', (req as any).requestId));
        return;
      }
      const { project_name, runtime_choice } = req.body || {};

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
          `INSERT INTO vibe_projects.projects (name, description, is_active, runtime_choice, client_id, created_by, updated_by)
           VALUES (${escapeSql(derivedName)}, ${escapeSql('Auto-provisioned project')}, true, ${escapeSql(runtime_choice || 'kimi')}, ${escapeSql(clientId)}, ${escapeSql(userId)}, ${escapeSql(userId)})
           RETURNING id`
        );
        if (!createProject.success || !createProject.data?.length) {
          res.status(500).json(error('INTERNAL_ERROR', createProject.error?.message || 'Project creation failed', 'agent_init_project', (req as any).requestId));
          return;
        }
        projectId = createProject.data[0].id;
        isNewlyCreated = true;
      }

      // Ensure 2 default agents exist in vibe.documents (canonical docstore).
      // Core team IDs are fixed (BAPert=2, QAPert=5) to match .NET AgentSchemaProvisioningService seed.
      const defaultAgents = [
        { name: 'BAPert', display_name: 'Business Analyst and Product Strategist', role: 'team-lead', id: 2 },
        { name: 'QAPert', display_name: 'QA Analyst Specialist', role: 'qa-analyst', id: 5 },
      ];

      const agentsCreated: Array<{ id: number; name: string; display_name: string }> = [];
      for (const agent of defaultAgents) {
        const check = await queryVibeSql(
          `SELECT document_id, data FROM vibe.documents
           WHERE client_id = 0 AND collection = 'vibe_agents' AND table_name = 'agent_profiles'
             AND data->>'name' = ${escapeSql(agent.name)} AND deleted_at IS NULL`
        );
        if (check.success && check.data?.length) {
          const rowData = check.data[0];
          const data = typeof rowData.data === 'string' ? JSON.parse(rowData.data) : rowData.data;
          agentsCreated.push({ id: data.id ?? rowData.document_id, name: data.name, display_name: data.display_name });
        } else {
          const agentJson = escapeJsonb({
            id: agent.id,
            name: agent.name,
            display_name: agent.display_name,
            role: agent.role,
            agent_type: 'team',
            is_active: true,
            is_shared: true,
            program: 'claude-code',
            model: 'claude-sonnet-4-6',
            expertise_tags: [],
            identity_prompt: `I am ${agent.name}, ${agent.display_name}.`,
            created_at: new Date().toISOString(),
          });
          const insert = await queryVibeSql(
            `INSERT INTO vibe.documents (client_id, user_id, collection, table_name, data, created_at, created_by)
             VALUES (0, NULL, 'vibe_agents', 'agent_profiles', ${agentJson}, CURRENT_TIMESTAMP, 0)
             RETURNING document_id, data`
          );
          if (insert.success && insert.data?.length) {
            const rowData = insert.data[0];
            const data = typeof rowData.data === 'string' ? JSON.parse(rowData.data) : rowData.data;
            agentsCreated.push({ id: data.id ?? rowData.document_id, name: data.name, display_name: data.display_name });
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

  // ── Skills persistence (NextPert #5 skill chips) ─────────────────────────

  // Load acp-skills.json catalog once at module init for validation
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  function loadSkillsCatalog(): string[] {
    try {
      const catalogPath = path.resolve(__dirname, '../../../acp-desktop/skills/acp-skills.json');
      const raw = fs.readFileSync(catalogPath, 'utf-8');
      const json = JSON.parse(raw);
      return (json.skills || []).map((s: any) => s.name);
    } catch (err) {
      console.warn('[agents/skills] Could not load acp-skills.json:', err);
      return [];
    }
  }
  const skillsCatalog = loadSkillsCatalog();

  // GET /v1/agents/:id/skills
  router.get('/:id/skills', async (req: Request, res: Response) => {
    try {
      const id = parseInt(req.params.id as string, 10);
      if (isNaN(id)) {
        res.status(400).json(error('VALIDATION_ERROR', 'id must be an integer', 'agent_skills_get', (req as any).requestId));
        return;
      }
      const result = await queryVibeSql(
        `SELECT data FROM vibe.documents WHERE client_id = 0 AND collection = 'vibe_agents' AND table_name = 'agent_profiles' AND data->>'id' = ${escapeSql(String(id))} AND deleted_at IS NULL`
      );
      if (!result.success || !result.data?.length) {
        res.status(404).json(error('AGENT_NOT_FOUND', 'Agent not found', 'agent_skills_get', (req as any).requestId));
        return;
      }
      const data = typeof result.data[0].data === 'string' ? JSON.parse(result.data[0].data) : result.data[0].data;
      res.json(success({ skills: data.skills || [] }, 'agent_skills_get', (req as any).requestId));
    } catch (err: any) {
      res.status(500).json(error('INTERNAL_ERROR', err.message, 'agent_skills_get', (req as any).requestId));
    }
  });

  // PUT /v1/agents/:id/skills
  router.put('/:id/skills', async (req: Request, res: Response) => {
    try {
      const id = parseInt(req.params.id as string, 10);
      if (isNaN(id)) {
        res.status(400).json(error('VALIDATION_ERROR', 'id must be an integer', 'agent_skills_put', (req as any).requestId));
        return;
      }
      const { skills } = req.body || {};
      if (!Array.isArray(skills) || skills.some((s: any) => typeof s !== 'string')) {
        res.status(400).json(error('VALIDATION_ERROR', 'skills must be an array of strings', 'agent_skills_put', (req as any).requestId));
        return;
      }
      const invalid = skills.filter((s: string) => !skillsCatalog.includes(s));
      if (invalid.length > 0 && skillsCatalog.length > 0) {
        res.status(400).json(error('VALIDATION_ERROR', `Invalid skills: ${invalid.join(', ')}. Valid: ${skillsCatalog.join(', ')}`, 'agent_skills_put', (req as any).requestId));
        return;
      }
      const patch = escapeJsonb({ skills });
      const sql = `UPDATE vibe.documents SET data = data || ${patch}, updated_at = NOW() WHERE client_id = 0 AND collection = 'vibe_agents' AND table_name = 'agent_profiles' AND data->>'id' = ${escapeSql(String(id))} AND deleted_at IS NULL RETURNING document_id, data`;
      const result = await queryVibeSql(sql);
      if (!result.success || !result.data?.length) {
        res.status(404).json(error('AGENT_NOT_FOUND', 'Agent not found', 'agent_skills_put', (req as any).requestId));
        return;
      }
      const rowData = result.data[0];
      const data = typeof rowData.data === 'string' ? JSON.parse(rowData.data) : rowData.data;
      res.json(success({ skills: data.skills || [] }, 'agent_skills_put', (req as any).requestId));
    } catch (err: any) {
      res.status(500).json(error('INTERNAL_ERROR', err.message, 'agent_skills_put', (req as any).requestId));
    }
  });

  return router;
}
