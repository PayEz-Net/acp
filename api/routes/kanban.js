import { Router } from 'express';
import { success } from '../response.js';
import { createTask, getTask, listTasks, moveTask, assignTask } from '../../kanban/board.js';
import { reviewTask, autoMailOnStatusChange } from '../../kanban/review.js';
import { sendMail } from '../../collaboration/mail.js';

export default function kanbanRoutes(storage) {
  const router = Router();

  router.post('/tasks', async (req, res, next) => {
    try {
      req.operationCode = 'kanban_create';
      const id = await createTask(storage, req.body);
      const elapsed = Math.round(performance.now() - req.startTime);
      res.json(success({ id }, 'kanban_create', req.requestId, {
        performance: { response_time_ms: elapsed },
      }));
    } catch (err) {
      next(err);
    }
  });

  router.get('/tasks', async (req, res, next) => {
    try {
      req.operationCode = 'kanban_list';
      const filter = {};
      if (req.query.status) filter.status = req.query.status.split(',');
      if (req.query.assignedTo) filter.assignedTo = req.query.assignedTo;
      if (req.query.milestone) filter.milestone = req.query.milestone;
      if (req.query.priority) filter.priority = req.query.priority;
      const tasks = await listTasks(storage, filter);
      const elapsed = Math.round(performance.now() - req.startTime);
      res.json(success(tasks, 'kanban_list', req.requestId, {
        performance: { response_time_ms: elapsed },
      }));
    } catch (err) {
      next(err);
    }
  });

  router.get('/tasks/:id', async (req, res, next) => {
    try {
      req.operationCode = 'kanban_get';
      const task = await getTask(storage, parseInt(req.params.id, 10));
      const elapsed = Math.round(performance.now() - req.startTime);
      res.json(success(task, 'kanban_get', req.requestId, {
        performance: { response_time_ms: elapsed },
      }));
    } catch (err) {
      next(err);
    }
  });

  router.put('/tasks/:id/status', async (req, res, next) => {
    try {
      req.operationCode = 'kanban_status';
      const { status } = req.body || {};
      if (!status) {
        const err = new Error('Status is required');
        err.code = 'INVALID_REQUEST';
        throw err;
      }
      const task = await moveTask(storage, parseInt(req.params.id, 10), status);
      await autoMailOnStatusChange(storage, sendMail, task, status);
      const elapsed = Math.round(performance.now() - req.startTime);
      res.json(success(task, 'kanban_status', req.requestId, {
        performance: { response_time_ms: elapsed },
      }));
    } catch (err) {
      next(err);
    }
  });

  router.put('/tasks/:id/assign', async (req, res, next) => {
    try {
      req.operationCode = 'kanban_assign';
      const { agent } = req.body || {};
      if (!agent) {
        const err = new Error('Agent is required');
        err.code = 'INVALID_REQUEST';
        throw err;
      }
      const task = await assignTask(storage, parseInt(req.params.id, 10), agent);
      const elapsed = Math.round(performance.now() - req.startTime);
      res.json(success(task, 'kanban_assign', req.requestId, {
        performance: { response_time_ms: elapsed },
      }));
    } catch (err) {
      next(err);
    }
  });

  router.put('/tasks/:id/review', async (req, res, next) => {
    try {
      req.operationCode = 'kanban_review';
      const { action, notes, reviewer } = req.body || {};
      if (!action) {
        const err = new Error('Review action is required (approve, reject, comment)');
        err.code = 'INVALID_REQUEST';
        throw err;
      }
      const task = await reviewTask(storage, sendMail, parseInt(req.params.id, 10), action, { notes, reviewer });
      const elapsed = Math.round(performance.now() - req.startTime);
      res.json(success(task, 'kanban_review', req.requestId, {
        performance: { response_time_ms: elapsed },
      }));
    } catch (err) {
      next(err);
    }
  });

  return router;
}
