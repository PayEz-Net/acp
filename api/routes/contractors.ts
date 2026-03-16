import { Router, type Request, type Response } from 'express';
import { success, error } from '../response.js';
import { ContractorService } from '../contractors/service.js';

export default function contractorRoutes(contractorService: ContractorService): Router {
  const router = Router();

  // GET /v1/contractors/pool — list available profiles from pool directories
  router.get('/pool', async (req: Request, res: Response) => {
    try {
      const profiles = await contractorService.listPool();
      res.json(success(profiles, 'contractors_pool', (req as any).requestId));
    } catch (err: any) {
      res.status(500).json(error('INTERNAL_ERROR', err.message, 'contractors_pool', (req as any).requestId));
    }
  });

  // GET /v1/contractors/active — list contracts with agent profile data
  // ?status=active (default) | completed | all
  router.get('/active', async (req: Request, res: Response) => {
    try {
      const status = (req.query.status as string) || 'active';
      if (!['active', 'completed', 'all'].includes(status)) {
        res.status(400).json(error('VALIDATION_ERROR', 'status must be active, completed, or all', 'contractors_active', (req as any).requestId));
        return;
      }
      const contracts = await contractorService.listContracts(status as 'active' | 'completed' | 'all');
      res.json(success(contracts, 'contractors_active', (req as any).requestId));
    } catch (err: any) {
      res.status(500).json(error('INTERNAL_ERROR', err.message, 'contractors_active', (req as any).requestId));
    }
  });

  return router;
}
