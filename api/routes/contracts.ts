import { Router, type Request, type Response } from 'express';
import { success, error } from '../response.js';
import { ContractorService } from '../contractors/service.js';

export default function contractRoutes(contractorService: ContractorService): Router {
  const router = Router();

  // POST /v1/contracts/:contract_id/complete — mark contract complete
  router.post('/:contract_id/complete', async (req: Request, res: Response) => {
    try {
      const contractId = parseInt(req.params.contract_id as string, 10);
      if (isNaN(contractId)) {
        res.status(400).json(error('INVALID_REQUEST', 'contract_id must be an integer', 'contract_complete', (req as any).requestId));
        return;
      }

      const contract = await contractorService.completeContract(contractId);
      if (!contract) {
        res.status(404).json(error('NOT_FOUND', 'Contract not found or not active', 'contract_complete', (req as any).requestId));
        return;
      }

      res.json(success(contract, 'contract_complete', (req as any).requestId));
    } catch (err: any) {
      res.status(500).json(error('INTERNAL_ERROR', err.message, 'contract_complete', (req as any).requestId));
    }
  });

  return router;
}
