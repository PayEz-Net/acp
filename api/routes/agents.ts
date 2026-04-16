import { Router, type Request, type Response } from 'express';
import { success, error } from '../response.js';
import { config } from '../../config.js';

const VIBESQL_URL = process.env.VIBESQL_URL || 'http://10.0.0.93:52411';
const VIBESQL_SECRET = process.env.VIBESQL_SECRET || 'ContainersSuperDevSecret';

/**
 * Agent profile route - queries VibeSQL Server directly for agent profiles.
 */
export default function agentRoutes(_storage: any): Router {
  const router = Router();

  // GET /v1/agents/:name/profile
  router.get('/:name/profile', async (req: Request, res: Response) => {
    try {
      const name = req.params.name;
      if (!name || typeof name !== 'string') {
        res.status(400).json(error('VALIDATION_ERROR', 'name is required', 'agent_profile', (req as any).requestId));
        return;
      }

      // Query vibe_agents.agents via VibeSQL Server
      const sql = `SELECT id, name, display_name, role, identity_md, role_md, philosophy_md, communication_md, response_pattern_md, expertise_json FROM vibe_agents.agents WHERE name = '${name.replace(/'/g, "''")}' AND is_active = true LIMIT 1`;

      const vsqlRes = await fetch(`${VIBESQL_URL}/v1/query`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Secret ${VIBESQL_SECRET}`,
        },
        body: JSON.stringify({ sql }),
      });

      const vsqlData = await vsqlRes.json().catch(() => ({ success: false }));

      if (!vsqlData.success || !vsqlData.data?.length) {
        // Fallback to SessionManager for basic info
        const basic = await _storage.getAgentProfileFromGlobal(name);
        if (basic) {
          res.json(success(basic, 'agent_profile', (req as any).requestId));
          return;
        }
        res.status(404).json(error('NOT_FOUND', `Agent '${name}' not found`, 'agent_profile', (req as any).requestId));
        return;
      }

      const agent = vsqlData.data[0];
      const profile = {
        name: agent.name,
        displayName: agent.display_name || agent.name,
        role: agent.role || 'agent',
        identityMd: agent.identity_md || '',
        roleMd: agent.role_md || '',
        philosophyMd: agent.philosophy_md || '',
        communicationMd: agent.communication_md || '',
        responsePatternMd: agent.response_pattern_md || '',
        expertiseJson: agent.expertise_json ? JSON.parse(agent.expertise_json) : {},
        isActive: true,
        program: 'kimi-cli',
        model: 'moonshotai/kimi-k2.5',
      };

      res.json(success(profile, 'agent_profile', (req as any).requestId));
    } catch (err: any) {
      res.status(500).json(error('INTERNAL_ERROR', err.message, 'agent_profile', (req as any).requestId));
    }
  });

  return router;
}
