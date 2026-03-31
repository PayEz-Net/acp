import { Router, type Request, type Response } from 'express';
import { success, error } from '../response.js';

export default function documentRoutes(storage: any): Router {
  const router = Router();

  // GET /v1/documents — list agent documents from VibeSQL
  router.get('/', async (req: Request, res: Response) => {
    try {
      const docs = await storage.listDocuments();
      res.json(success(docs, 'documents_list', (req as any).requestId));
    } catch (err: any) {
      res.status(500).json(error('INTERNAL_ERROR', err.message, 'documents_list', (req as any).requestId));
    }
  });

  // GET /v1/documents/:id — get single document
  router.get('/:id', async (req: Request, res: Response) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (isNaN(id)) {
        res.status(400).json(error('VALIDATION_ERROR', 'Invalid document ID', 'document_get', (req as any).requestId));
        return;
      }
      const doc = await storage.getDocument(id);
      if (!doc) {
        res.status(404).json(error('NOT_FOUND', 'Document not found', 'document_get', (req as any).requestId));
        return;
      }
      res.json(success(doc, 'document_get', (req as any).requestId));
    } catch (err: any) {
      res.status(500).json(error('INTERNAL_ERROR', err.message, 'document_get', (req as any).requestId));
    }
  });

  // PUT /v1/documents/:id — update a document
  router.put('/:id', async (req: Request, res: Response) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (isNaN(id)) {
        res.status(400).json(error('VALIDATION_ERROR', 'Invalid document ID', 'document_update', (req as any).requestId));
        return;
      }
      const { title, content_md, document_type, version } = req.body;
      if (!title && !content_md && !document_type && version === undefined) {
        res.status(400).json(error('VALIDATION_ERROR', 'No update fields provided', 'document_update', (req as any).requestId));
        return;
      }
      const doc = await storage.updateDocument(id, { title, content_md, document_type, version });
      if (!doc) {
        res.status(404).json(error('NOT_FOUND', 'Document not found', 'document_update', (req as any).requestId));
        return;
      }
      res.json(success(doc, 'document_update', (req as any).requestId));
    } catch (err: any) {
      res.status(500).json(error('INTERNAL_ERROR', err.message, 'document_update', (req as any).requestId));
    }
  });

  // DELETE /v1/documents/:id — delete a document
  router.delete('/:id', async (req: Request, res: Response) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (isNaN(id)) {
        res.status(400).json(error('VALIDATION_ERROR', 'Invalid document ID', 'document_delete', (req as any).requestId));
        return;
      }
      const deleted = await storage.deleteDocument(id);
      if (!deleted) {
        res.status(404).json(error('NOT_FOUND', 'Document not found', 'document_delete', (req as any).requestId));
        return;
      }
      res.json(success({ id, deleted: true }, 'document_delete', (req as any).requestId));
    } catch (err: any) {
      res.status(500).json(error('INTERNAL_ERROR', err.message, 'document_delete', (req as any).requestId));
    }
  });

  return router;
}
