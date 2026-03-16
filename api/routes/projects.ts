import { Router, type Request, type Response } from 'express';
import { success, error, statusForCode } from '../response.js';
import type { LocalEventBus } from '../sse/localEventBus.js';

export default function projectRoutes(storage: any, eventBus: LocalEventBus): Router {
  const router = Router();

  // GET /v1/projects — list all projects
  router.get('/', async (req: Request, res: Response) => {
    try {
      const projects = await storage.listProjects();
      res.json(success(projects, 'projects_list', (req as any).requestId));
    } catch (err: any) {
      res.status(500).json(error('INTERNAL_ERROR', err.message, 'projects_list', (req as any).requestId));
    }
  });

  // GET /v1/projects/active — get current active project
  router.get('/active', async (req: Request, res: Response) => {
    try {
      const projectId = await storage.getActiveProjectId();
      if (!projectId) {
        res.status(404).json(error('NOT_FOUND', 'No active project set', 'project_active', (req as any).requestId));
        return;
      }
      const project = await storage.getProject(projectId);
      if (!project) {
        res.status(404).json(error('NOT_FOUND', 'Active project not found', 'project_active', (req as any).requestId));
        return;
      }
      res.json(success(project, 'project_active', (req as any).requestId));
    } catch (err: any) {
      res.status(500).json(error('INTERNAL_ERROR', err.message, 'project_active', (req as any).requestId));
    }
  });

  // POST /v1/projects/active — set active project
  router.post('/active', async (req: Request, res: Response) => {
    try {
      const { project_id } = req.body || {};
      if (!project_id || isNaN(parseInt(project_id, 10))) {
        res.status(400).json(error('VALIDATION_ERROR', 'project_id required (integer)', 'project_set_active', (req as any).requestId));
        return;
      }
      const id = parseInt(project_id, 10);
      const project = await storage.getProject(id);
      if (!project) {
        res.status(404).json(error('NOT_FOUND', 'Project not found', 'project_set_active', (req as any).requestId));
        return;
      }
      await storage.setActiveProjectId(id);

      // SSE: project-switched
      eventBus.emit({
        event: 'project-switched',
        data: { project_id: id, project_name: project.name },
      });

      res.json(success(project, 'project_set_active', (req as any).requestId));
    } catch (err: any) {
      res.status(500).json(error('INTERNAL_ERROR', err.message, 'project_set_active', (req as any).requestId));
    }
  });

  // POST /v1/projects — create project
  router.post('/', async (req: Request, res: Response) => {
    try {
      const { name, description } = req.body || {};
      if (!name || typeof name !== 'string' || name.trim().length === 0) {
        res.status(400).json(error('VALIDATION_ERROR', 'name is required', 'project_create', (req as any).requestId));
        return;
      }
      const project = await storage.createProject(name.trim(), description || null);
      if (!project) {
        res.status(409).json(error('CONFLICT', 'Project with that name already exists', 'project_create', (req as any).requestId));
        return;
      }
      res.status(201).json(success(project, 'project_create', (req as any).requestId));
    } catch (err: any) {
      if (err.message?.includes('unique') || err.message?.includes('duplicate')) {
        res.status(409).json(error('CONFLICT', 'Project with that name already exists', 'project_create', (req as any).requestId));
      } else {
        res.status(500).json(error('INTERNAL_ERROR', err.message, 'project_create', (req as any).requestId));
      }
    }
  });

  // GET /v1/projects/:id — get project detail
  router.get('/:id', async (req: Request, res: Response) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (isNaN(id)) {
        res.status(400).json(error('VALIDATION_ERROR', 'id must be an integer', 'project_get', (req as any).requestId));
        return;
      }
      const project = await storage.getProject(id);
      if (!project) {
        res.status(404).json(error('NOT_FOUND', 'Project not found', 'project_get', (req as any).requestId));
        return;
      }
      res.json(success(project, 'project_get', (req as any).requestId));
    } catch (err: any) {
      res.status(500).json(error('INTERNAL_ERROR', err.message, 'project_get', (req as any).requestId));
    }
  });

  // PATCH /v1/projects/:id — update project
  router.patch('/:id', async (req: Request, res: Response) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (isNaN(id)) {
        res.status(400).json(error('VALIDATION_ERROR', 'id must be an integer', 'project_update', (req as any).requestId));
        return;
      }
      const { name, description, status } = req.body || {};
      if (status && !['active', 'archived', 'completed'].includes(status)) {
        res.status(400).json(error('VALIDATION_ERROR', 'status must be active, archived, or completed', 'project_update', (req as any).requestId));
        return;
      }
      const project = await storage.updateProject(id, { name, description, status });
      if (!project) {
        res.status(404).json(error('NOT_FOUND', 'Project not found', 'project_update', (req as any).requestId));
        return;
      }
      res.json(success(project, 'project_update', (req as any).requestId));
    } catch (err: any) {
      res.status(500).json(error('INTERNAL_ERROR', err.message, 'project_update', (req as any).requestId));
    }
  });

  return router;
}
