import { Router, type Request, type Response } from 'express';
import { success, error } from '../response.js';
import { config } from '../../config.js';

const VIBESQL_URL = process.env.VIBESQL_URL || 'http://10.0.0.93:52411';
const VIBESQL_SECRET = process.env.VIBESQL_SECRET || 'ContainersSuperDevSecret';

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
      res.json(success({ agents, total: agents.length, active_count: agents.length }, 'agent_startup_config', (req as any).requestId));
    } catch (err: any) {
      res.status(500).json(error('INTERNAL_ERROR', err.message, 'agent_startup_config', (req as any).requestId));
    }
  });

  // PATCH /v1/agents/:id/activation
  router.patch('/:id/activation', async (req: Request, res: Response) => {
    try {
      const id = parseInt(req.params.id, 10);
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
      const id = parseInt(req.params.id, 10);
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
      const existing = await queryVibeSql(`SELECT id FROM vibe_agents.agents WHERE name = ${escapeSql(trimmedName)}`);
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

      await queryVibeSql(`DO $$ BEGIN ${updates} END $$`);
      res.json(success({ updated: order.length }, 'agent_startup_order', (req as any).requestId));
    } catch (err: any) {
      res.status(500).json(error('INTERNAL_ERROR', err.message, 'agent_startup_order', (req as any).requestId));
    }
  });

  // PUT /v1/agents/:id/capabilities
  router.put('/:id/capabilities', async (req: Request, res: Response) => {
    try {
      const id = parseInt(req.params.id, 10);
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
      const id = parseInt(req.params.id, 10);
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
      const email = getBearerEmail(req);
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

      // Check for existing project in public.projects
      const existingProject = await queryVibeSql(
        `SELECT id, name FROM public.projects WHERE name = ${escapeSql(derivedName)} LIMIT 1`
      );

      let projectId: number;
      let isNewlyCreated = false;

      if (existingProject.success && existingProject.data?.length) {
        projectId = existingProject.data[0].id;
      } else {
        const createProject = await queryVibeSql(
          `INSERT INTO public.projects (name, description, status) VALUES (${escapeSql(derivedName)}, ${escapeSql('Auto-provisioned project')}, 'active') RETURNING id`
        );
        if (!createProject.success || !createProject.data?.length) {
          res.status(500).json(error('INTERNAL_ERROR', createProject.error?.message || 'Project creation failed', 'agent_init_project', (req as any).requestId));
          return;
        }
        projectId = createProject.data[0].id;
        isNewlyCreated = true;
      }

      // Ensure 5 default agents exist in vibe_agents.agents
      const defaultAgents = [
        { name: 'Aurum', display_name: 'Platform Architect and Operations', role: 'platform-architect' },
        { name: 'BAPert', display_name: 'Business Analyst and Product Strategist', role: 'team-lead' },
        { name: 'NextPert', display_name: 'Next.js Frontend Specialist', role: 'frontend-developer' },
        { name: 'QAPert', display_name: 'QA Analyst Specialist', role: 'qa-analyst' },
        { name: 'DotNetPert', display_name: '.NET Backend Specialist', role: 'backend-developer' },
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
            `INSERT INTO vibe_agents.agents (name, display_name, role, is_active, capabilities, safety_rules)
             VALUES (${escapeSql(agent.name)}, ${escapeSql(agent.display_name)}, ${escapeSql(agent.role)}, true, '{}'::jsonb, '[]'::jsonb)
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

  // GET /v1/agents/:name/profile  (existing — enhanced for dual-mode)
  router.get('/:identifier/profile', async (req: Request, res: Response) => {
    try {
      const identifier = req.params.identifier;
      if (!identifier || typeof identifier !== 'string') {
        res.status(400).json(error('VALIDATION_ERROR', 'identifier is required', 'agent_profile', (req as any).requestId));
        return;
      }

      let sql: string;
      const isNumericId = /^\d+$/.test(identifier);
      if (isNumericId) {
        sql = `SELECT id, name, display_name, role, identity_md, role_md, philosophy_md, communication_md, response_pattern_md, expertise_json, is_active, capabilities, safety_rules
               FROM vibe_agents.agents
               WHERE id = ${escapeSql(parseInt(identifier, 10))} AND is_active = true LIMIT 1`;
      } else {
        sql = `SELECT id, name, display_name, role, identity_md, role_md, philosophy_md, communication_md, response_pattern_md, expertise_json, is_active, capabilities, safety_rules
               FROM vibe_agents.agents
               WHERE name = ${escapeSql(identifier.replace(/'/g, "''"))} AND is_active = true LIMIT 1`;
      }

      const vsqlRes = await queryVibeSql(sql);
      if (!vsqlRes.success || !vsqlRes.data?.length) {
        // Fallback to SessionManager for basic info
        const basic = await _storage.getAgentProfileFromGlobal(identifier);
        if (basic) {
          res.json(success(basic, 'agent_profile', (req as any).requestId));
          return;
        }
        res.status(404).json(error('NOT_FOUND', `Agent '${identifier}' not found`, 'agent_profile', (req as any).requestId));
        return;
      }

      const agent = vsqlRes.data[0];
      const profile = {
        name: agent.name,
        displayName: agent.display_name || agent.name,
        role: agent.role || 'agent',
        identityMd: agent.identity_md || '',
        roleMd: agent.role_md || '',
        philosophyMd: agent.philosophy_md || '',
        communicationMd: agent.communication_md || '',
        responsePatternMd: agent.response_pattern_md || '',
        expertiseJson: agent.expertise_json ? (typeof agent.expertise_json === 'string' ? JSON.parse(agent.expertise_json) : agent.expertise_json) : {},
        capabilities: agent.capabilities ? (typeof agent.capabilities === 'string' ? JSON.parse(agent.capabilities) : agent.capabilities) : {},
        safetyRules: agent.safety_rules ? (typeof agent.safety_rules === 'string' ? JSON.parse(agent.safety_rules) : agent.safety_rules) : [],
        isActive: true,
        program: 'claude-code',
        model: 'claude-sonnet-4-6',
      };

      res.json(success(profile, 'agent_profile', (req as any).requestId));
    } catch (err: any) {
      res.status(500).json(error('INTERNAL_ERROR', err.message, 'agent_profile', (req as any).requestId));
    }
  });

  return router;
}
