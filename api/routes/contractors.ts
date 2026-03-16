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

  // GET /v1/contractors/active — list active contracts with agent profile data
  router.get('/active', async (req: Request, res: Response) => {
    try {
      const contracts = await contractorService.listActive();
      res.json(success(contracts, 'contractors_active', (req as any).requestId));
    } catch (err: any) {
      res.status(500).json(error('INTERNAL_ERROR', err.message, 'contractors_active', (req as any).requestId));
    }
  });

  return router;
}
