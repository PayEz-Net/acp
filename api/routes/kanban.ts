import { Router, type Request, type Response } from 'express';
import { success } from '../response.js';
import { createTask, getTask, listTasks, moveTask, assignTask } from '../../kanban/board.js';
import { reviewTask, autoMailOnStatusChange } from '../../kanban/review.js';
import { sendMail } from '../../collaboration/mail.js';
import type { LocalEventBus } from '../sse/localEventBus.js';

export default function kanbanRoutes(storage: any, localEventBus?: LocalEventBus): Router {
  const router = Router();

  router.post('/tasks', async (req: Request, res: Response, next) => {
    try {
      (req as any).operationCode = 'kanban_create';
      // Archived project guard
      const activeProjectId = await storage.getActiveProjectId();
      if (activeProjectId) {
        const project = await storage.getProject(activeProjectId);
        if (project?.status === 'archived') {
          res.status(403).json({ success: false, message: 'Project is archived', error: { code: 'PROJECT_ARCHIVED' } });
          return;
        }
      }
      // AC-6: set createdBy from auth context if not explicitly provided
      if (!req.body.createdBy && (req as any).agentName) {
        req.body.createdBy = (req as any).agentName;
      }
      const id = await createTask(storage, req.body);
      const elapsed = Math.round(performance.now() - (req as any).startTime);
      localEventBus?.emit({
        event: 'kanban-update',
        data: { action: 'created', task_id: id },
      });
      res.json(success({ id }, 'kanban_create', (req as any).requestId, {
        performance: { response_time_ms: elapsed },
      }));
    } catch (err) {
      next(err);
    }
  });

  router.get('/tasks', async (req: Request, res: Response, next) => {
    try {
      (req as any).operationCode = 'kanban_list';
      const filter: any = {};
      if (req.query.status) filter.status = (req.query.status as string).split(',');
      if (req.query.assignedTo) filter.assignedTo = req.query.assignedTo;
      if (req.query.milestone) filter.milestone = req.query.milestone;
      if (req.query.priority) filter.priority = req.query.priority;
      const tasks = await listTasks(storage, filter);
      const elapsed = Math.round(performance.now() - (req as any).startTime);
      res.json(success(tasks, 'kanban_list', (req as any).requestId, {
        performance: { response_time_ms: elapsed },
      }));
    } catch (err) {
      next(err);
    }
  });

  router.get('/tasks/:id', async (req: Request, res: Response, next) => {
    try {
      (req as any).operationCode = 'kanban_get';
      const task = await getTask(storage, parseInt(req.params.id as string, 10));
      const elapsed = Math.round(performance.now() - (req as any).startTime);
      res.json(success(task, 'kanban_get', (req as any).requestId, {
        performance: { response_time_ms: elapsed },
      }));
    } catch (err) {
      next(err);
    }
  });

  router.put('/tasks/:id/status', async (req: Request, res: Response, next) => {
    try {
      (req as any).operationCode = 'kanban_status';
      const { status } = req.body || {};
      if (!status) {
        const err = new Error('Status is required') as Error & { code?: string };
        err.code = 'INVALID_REQUEST';
        throw err;
      }
      const task = await moveTask(storage, parseInt(req.params.id as string, 10), status);
      await autoMailOnStatusChange(storage, sendMail, task, status);
      localEventBus?.emit({
        event: 'kanban-update',
        data: { action: 'status_changed', task_id: req.params.id, status },
      });
      const elapsed = Math.round(performance.now() - (req as any).startTime);
      res.json(success(task, 'kanban_status', (req as any).requestId, {
        performance: { response_time_ms: elapsed },
      }));
    } catch (err) {
      next(err);
    }
  });

  router.put('/tasks/:id/assign', async (req: Request, res: Response, next) => {
    try {
      (req as any).operationCode = 'kanban_assign';
      const { agent } = req.body || {};
      if (!agent) {
        const err = new Error('Agent is required') as Error & { code?: string };
        err.code = 'INVALID_REQUEST';
        throw err;
      }
      const requireUnassigned = req.body.requireUnassigned === true;
      const task = await assignTask(storage, parseInt(req.params.id as string, 10), agent, { requireUnassigned });
      localEventBus?.emit({
        event: 'kanban-update',
        data: { action: 'assigned', task_id: req.params.id, agent },
      });
      const elapsed = Math.round(performance.now() - (req as any).startTime);
      res.json(success(task, 'kanban_assign', (req as any).requestId, {
        performance: { response_time_ms: elapsed },
      }));
    } catch (err: any) {
      if (err.code === 'CONFLICT') {
        res.status(409).json({ success: false, message: err.message, error: { code: 'CONFLICT' } });
        return;
      }
      next(err);
    }
  });

  router.put('/tasks/:id/review', async (req: Request, res: Response, next) => {
    try {
      (req as any).operationCode = 'kanban_review';
      const { action, notes, reviewer } = req.body || {};
      if (!action) {
        const err = new Error('Review action is required (approve, reject, comment)') as Error & { code?: string };
        err.code = 'INVALID_REQUEST';
        throw err;
      }
      const task = await reviewTask(storage, sendMail, parseInt(req.params.id as string, 10), action, { notes, reviewer });
      localEventBus?.emit({
        event: 'kanban-update',
        data: { action: 'reviewed', task_id: req.params.id, review_action: action },
      });
      const elapsed = Math.round(performance.now() - (req as any).startTime);
      res.json(success(task, 'kanban_review', (req as any).requestId, {
        performance: { response_time_ms: elapsed },
      }));
    } catch (err) {
      next(err);
    }
  });

  return router;
}
