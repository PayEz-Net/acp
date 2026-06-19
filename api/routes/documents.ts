import { Router, type Request, type Response } from 'express';
import { success, error } from '../response.js';

/**
 * Project documents (WO 8196 lane B). Thin pass-through to the CLOUD-backed
 * storage.* methods, which proxy the project-scoped typed endpoint
 * /v1/projects/:id/documents. There is NO in-memory store: a persistence
 * failure surfaces as 503 DOCS_PERSISTENCE_NOT_WIRED with the VERBATIM cause —
 * never a silent empty list, fake success, or `|| []`. Until DnP deploys the
 * cloud endpoint, every call honest-fails (the cloud 404 is surfaced verbatim).
 */
export default function documentRoutes(storage: any): Router {
  const router = Router();

  // Documents are project-scoped. The renderer auto-appends ?project_id= (see
  // api-helpers.buildUrl); create may also carry it in the body. A missing
  // project_id is a hard 400 — never a silent global query.
  function resolveProjectId(req: Request): number | null {
    const raw =
      (req.body && req.body.project_id) ??
      (req.query && (req.query.project_id as string | undefined));
    if (raw === undefined || raw === null || raw === '') return null;
    const pid = parseInt(String(raw), 10);
    return Number.isNaN(pid) ? null : pid;
  }

  // Honest-fail: persistence-layer throws => 503 + verbatim cause. Validation
  // (400) and not-found (404) are handled inline before the catch.
  function persistenceError(res: Response, req: Request, op: string, err: any) {
    res.status(503).json(
      error('DOCS_PERSISTENCE_NOT_WIRED', err?.message || String(err), op, (req as any).requestId),
    );
  }

  // GET /v1/documents?project_id=N — list documents for a project
  router.get('/', async (req: Request, res: Response) => {
    const projectId = resolveProjectId(req);
    if (projectId === null) {
      res.status(400).json(error('VALIDATION_ERROR', 'project_id is required (documents are project-scoped)', 'documents_list', (req as any).requestId));
      return;
    }
    try {
      const docs = await storage.listDocuments({ project_id: projectId });
      res.json(success(docs, 'documents_list', (req as any).requestId));
    } catch (err: any) {
      persistenceError(res, req, 'documents_list', err);
    }
  });

  // POST /v1/documents — create a new document
  router.post('/', async (req: Request, res: Response) => {
    const projectId = resolveProjectId(req);
    if (projectId === null) {
      res.status(400).json(error('VALIDATION_ERROR', 'project_id is required (documents are project-scoped)', 'document_create', (req as any).requestId));
      return;
    }
    const { title, content_md, type, version, author_agent, parent_document_id } = req.body;
    if (!title || !content_md) {
      res.status(400).json(error('VALIDATION_ERROR', 'title and content_md are required', 'document_create', (req as any).requestId));
      return;
    }
    try {
      const doc = await storage.createDocument({ project_id: projectId, title, content_md, type, version, author_agent, parent_document_id });
      res.status(201).json(success(doc, 'document_create', (req as any).requestId));
    } catch (err: any) {
      persistenceError(res, req, 'document_create', err);
    }
  });

  // GET /v1/documents/:id?project_id=N — get single document
  router.get('/:id', async (req: Request, res: Response) => {
    const id = parseInt(req.params.id as string, 10);
    if (isNaN(id)) {
      res.status(400).json(error('VALIDATION_ERROR', 'Invalid document ID', 'document_get', (req as any).requestId));
      return;
    }
    const projectId = resolveProjectId(req);
    if (projectId === null) {
      res.status(400).json(error('VALIDATION_ERROR', 'project_id is required (documents are project-scoped)', 'document_get', (req as any).requestId));
      return;
    }
    try {
      const doc = await storage.getDocument(id, projectId);
      if (!doc) {
        res.status(404).json(error('NOT_FOUND', 'Document not found', 'document_get', (req as any).requestId));
        return;
      }
      res.json(success(doc, 'document_get', (req as any).requestId));
    } catch (err: any) {
      persistenceError(res, req, 'document_get', err);
    }
  });

  // PUT /v1/documents/:id?project_id=N — update a document (partial fields)
  router.put('/:id', async (req: Request, res: Response) => {
    const id = parseInt(req.params.id as string, 10);
    if (isNaN(id)) {
      res.status(400).json(error('VALIDATION_ERROR', 'Invalid document ID', 'document_update', (req as any).requestId));
      return;
    }
    const projectId = resolveProjectId(req);
    if (projectId === null) {
      res.status(400).json(error('VALIDATION_ERROR', 'project_id is required (documents are project-scoped)', 'document_update', (req as any).requestId));
      return;
    }
    const { title, content_md, document_type, version, author_agent, parent_document_id } = req.body;
    if (title === undefined && content_md === undefined && document_type === undefined && version === undefined && author_agent === undefined && parent_document_id === undefined) {
      res.status(400).json(error('VALIDATION_ERROR', 'No update fields provided', 'document_update', (req as any).requestId));
      return;
    }
    try {
      const doc = await storage.updateDocument(id, { title, content_md, document_type, version, author_agent, parent_document_id }, projectId);
      if (!doc) {
        res.status(404).json(error('NOT_FOUND', 'Document not found', 'document_update', (req as any).requestId));
        return;
      }
      res.json(success(doc, 'document_update', (req as any).requestId));
    } catch (err: any) {
      persistenceError(res, req, 'document_update', err);
    }
  });

  // DELETE /v1/documents/:id?project_id=N — soft-delete a document
  router.delete('/:id', async (req: Request, res: Response) => {
    const id = parseInt(req.params.id as string, 10);
    if (isNaN(id)) {
      res.status(400).json(error('VALIDATION_ERROR', 'Invalid document ID', 'document_delete', (req as any).requestId));
      return;
    }
    const projectId = resolveProjectId(req);
    if (projectId === null) {
      res.status(400).json(error('VALIDATION_ERROR', 'project_id is required (documents are project-scoped)', 'document_delete', (req as any).requestId));
      return;
    }
    try {
      const deleted = await storage.deleteDocument(id, projectId);
      if (!deleted) {
        res.status(404).json(error('NOT_FOUND', 'Document not found', 'document_delete', (req as any).requestId));
        return;
      }
      res.json(success({ id, deleted: true }, 'document_delete', (req as any).requestId));
    } catch (err: any) {
      persistenceError(res, req, 'document_delete', err);
    }
  });

  return router;
}
