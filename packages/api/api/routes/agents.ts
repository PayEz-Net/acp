import { Router, type Request, type Response } from 'express';
import { success, error } from '../response.js';

export default function agentRoutes(storage: any): Router {
  const router = Router();

  // PATCH /v1/agents/:id/activation — toggle is_active + set startup_order
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

      const existing = await storage.getAgentById(id);
      if (!existing) {
        res.status(404).json(error('AGENT_NOT_FOUND', 'Agent not found', 'agent_activation', (req as any).requestId));
        return;
      }

      const updates: any = { isActive: is_active };
      if (startup_order !== undefined) {
        const order = parseInt(startup_order, 10);
        if (isNaN(order) || order < 0) {
          res.status(400).json(error('VALIDATION_ERROR', 'startup_order must be a non-negative integer', 'agent_activation', (req as any).requestId));
          return;
        }
        updates.startupOrder = order;
      }

      const agent = await storage.updateAgent(id, updates);
      res.json(success(agent, 'agent_activation', (req as any).requestId));
    } catch (err: any) {
      res.status(500).json(error('INTERNAL_ERROR', err.message, 'agent_activation', (req as any).requestId));
    }
  });

  // GET /v1/agents/startup-config — active agents sorted by startup_order
  router.get('/startup-config', async (req: Request, res: Response) => {
    try {
      const agents = await storage.listActiveAgents();
      const allAgents = await storage.listAllAgents();
      res.json(success({
        agents,
        total: allAgents.length,
        active_count: agents.length,
      }, 'agent_startup_config', (req as any).requestId));
    } catch (err: any) {
      res.status(500).json(error('INTERNAL_ERROR', err.message, 'agent_startup_config', (req as any).requestId));
    }
  });

  // GET /v1/agents/:name/profile/composed — full agent identity + skills in one call
  router.get('/:name/profile/composed', async (req: Request, res: Response) => {
    try {
      const name = req.params.name;
      if (!name || typeof name !== 'string' || name.trim().length === 0) {
        res.status(400).json(error('VALIDATION_ERROR', 'Agent name is required', 'agent_profile_composed', (req as any).requestId));
        return;
      }

      // Skip numeric-only names to avoid conflict with /:id routes
      if (/^\d+$/.test(name.trim())) {
        res.status(400).json(error('VALIDATION_ERROR', 'Agent name must not be purely numeric', 'agent_profile_composed', (req as any).requestId));
        return;
      }

      const profile = await storage.getGlobalAgentProfile(name.trim());
      if (!profile) {
        res.status(404).json(error('AGENT_NOT_FOUND', `Agent '${name}' not found or inactive`, 'agent_profile_composed', (req as any).requestId));
        return;
      }

      const skills = await storage.getAgentSkills(profile.id);

      // Compose full markdown
      const sections = [
        profile.identityMd,
        profile.roleMd,
        profile.philosophyMd,
        profile.communicationMd,
        profile.responsePatternMd,
      ].filter(Boolean);

      for (const skill of skills) {
        if (skill.instructionMd) {
          sections.push(`---\n\n## Skill: ${skill.displayName || skill.name}\n\n${skill.instructionMd}`);
        }
      }

      const composedMd = sections.join('\n\n---\n\n');

      res.json(success({
        agent: {
          id: profile.id,
          name: profile.name,
          display_name: profile.displayName,
          role: profile.role,
        },
        identity: {
          identity_md: profile.identityMd,
          role_md: profile.roleMd,
          philosophy_md: profile.philosophyMd,
          communication_md: profile.communicationMd,
          response_pattern_md: profile.responsePatternMd,
        },
        skills: skills.map((s: any) => ({
          name: s.name,
          display_name: s.displayName,
          instruction_md: s.instructionMd,
          config: s.configJson || {},
        })),
        composed_md: composedMd,
      }, 'agent_profile_composed', (req as any).requestId));
    } catch (err: any) {
      res.status(500).json(error('INTERNAL_ERROR', err.message, 'agent_profile_composed', (req as any).requestId));
    }
  });

  // DELETE /v1/agents/:id — soft-delete agent (set deleted_at, preserve mail history)
  router.delete('/:id', async (req: Request, res: Response) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (isNaN(id)) {
        res.status(400).json(error('VALIDATION_ERROR', 'id must be an integer', 'agent_delete', (req as any).requestId));
        return;
      }

      const existing = await storage.getAgentById(id);
      if (!existing) {
        res.status(404).json(error('AGENT_NOT_FOUND', 'Agent not found', 'agent_delete', (req as any).requestId));
        return;
      }

      await storage.softDeleteAgent(id);
      res.json(success({ id, name: existing.name, deleted: true }, 'agent_delete', (req as any).requestId));
    } catch (err: any) {
      res.status(500).json(error('INTERNAL_ERROR', err.message, 'agent_delete', (req as any).requestId));
    }
  });

  // POST /v1/agents/hire — create agent from template (pool profile)
  router.post('/hire', async (req: Request, res: Response) => {
    try {
      const { template_name, name, display_name, is_active, description, role } = req.body || {};

      if (!name || typeof name !== 'string' || name.trim().length === 0) {
        res.status(400).json(error('VALIDATION_ERROR', 'name is required', 'agent_hire', (req as any).requestId));
        return;
      }

      // Check if agent name already exists
      const existingAgent = await storage.getAgentByName(name.trim());
      if (existingAgent) {
        res.status(409).json(error('CONFLICT', 'Agent with that name already exists', 'agent_hire', (req as any).requestId));
        return;
      }

      // If template_name provided, look up pool profile to copy fields
      let templateData: any = {};
      if (template_name) {
        const profiles = await storage.listPoolProfiles();
        const profile = profiles.find((p: any) => p.name === template_name);
        if (profile) {
          templateData = {
            displayName: profile.displayName || profile.name,
            role: profile.description || null,
            model: profile.model || null,
            expertiseJson: profile.tools ? { tools: profile.tools } : {},
          };
        }
        // Pool profile not found is OK — frontend templates pass description/role directly
      }

      // Priority: request body fields > pool profile fields > defaults
      const agent = await storage.upsertAgent({
        name: name.trim(),
        displayName: display_name || templateData.displayName || name.trim(),
        role: role || description || templateData.role || null,
        model: templateData.model || null,
        expertiseJson: templateData.expertiseJson || {},
        agentType: is_active ? 'team' : 'contractor',
        isActive: is_active !== undefined ? is_active : false,
      });

      res.status(201).json(success(agent, 'agent_hire', (req as any).requestId));
    } catch (err: any) {
      res.status(500).json(error('INTERNAL_ERROR', err.message, 'agent_hire', (req as any).requestId));
    }
  });

  // PUT /v1/agents/startup-order — bulk transactional update for drag-reorder
  router.put('/startup-order', async (req: Request, res: Response) => {
    try {
      const { order } = req.body || {};
      if (!Array.isArray(order) || order.length === 0) {
        res.status(400).json(error('VALIDATION_ERROR', 'order must be a non-empty array of { agent_id, startup_order }', 'agent_startup_order', (req as any).requestId));
        return;
      }

      // Validate all entries
      for (const entry of order) {
        if (!entry.agent_id || isNaN(parseInt(entry.agent_id, 10))) {
          res.status(400).json(error('VALIDATION_ERROR', 'Each entry must have a valid agent_id', 'agent_startup_order', (req as any).requestId));
          return;
        }
        if (entry.startup_order === undefined || isNaN(parseInt(entry.startup_order, 10)) || parseInt(entry.startup_order, 10) < 0) {
          res.status(400).json(error('VALIDATION_ERROR', 'Each entry must have a non-negative startup_order', 'agent_startup_order', (req as any).requestId));
          return;
        }
      }

      await storage.bulkUpdateStartupOrder(order);
      res.json(success({ updated: order.length }, 'agent_startup_order', (req as any).requestId));
    } catch (err: any) {
      res.status(500).json(error('INTERNAL_ERROR', err.message, 'agent_startup_order', (req as any).requestId));
    }
  });

  return router;
}
