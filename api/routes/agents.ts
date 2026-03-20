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
      res.json(success({
        agents,
        total: agents.length,
        active_count: agents.length,
      }, 'agent_startup_config', (req as any).requestId));
    } catch (err: any) {
      res.status(500).json(error('INTERNAL_ERROR', err.message, 'agent_startup_config', (req as any).requestId));
    }
  });

  return router;
}
