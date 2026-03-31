import { Router, type Request, type Response } from 'express';
import { success, error } from '../response.js';
import type { BackoffManager } from '../lifecycle/backoff.js';
import type { HealthMonitor } from '../lifecycle/healthMonitor.js';
import type { Config } from '../../config.js';

interface LifecycleDeps {
  cfg: Config;
  backoff: BackoffManager;
  healthMonitor: HealthMonitor;
  callbackPort: number;
  bootstrap: (agentName: string) => Promise<{ session: any; source: string }>;
}

const CALLBACK_TIMEOUT_MS = 10_000;

async function callElectron(
  cfg: Config,
  callbackPort: number,
  path: string,
  body: Record<string, unknown>
): Promise<{ status: number; data: any }> {
  const url = `http://127.0.0.1:${callbackPort}${path}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CALLBACK_TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${cfg.acpLocalSecret}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const data = await res.json();
    return { status: res.status, data };
  } finally {
    clearTimeout(timeout);
  }
}

export default function agentLifecycleRoutes(deps: LifecycleDeps): Router {
  const { cfg, backoff, healthMonitor, callbackPort, bootstrap } = deps;
  const router = Router();

  // POST /v1/lifecycle/agents/:name/spawn
  router.post('/:name/spawn', async (req: Request, res: Response) => {
    const name = req.params.name as string;
    const { workDir, autoReport } = req.body || {};

    try {
      const state = backoff.getOrCreate(name);
      state.status = 'spawning';
      state.workDir = workDir || null;
      state.autoReport = autoReport !== false;

      // Bootstrap session
      const { session } = await bootstrap(name);

      // Call Electron to spawn PTY
      const result = await callElectron(cfg, callbackPort, '/internal/pty/spawn', {
        agentName: name,
        workDir: workDir || undefined,
        autoReport: state.autoReport,
      });

      // 409 = agent already running — reuse existing terminalId
      if (result.status === 409) {
        const existingId = result.data?.terminalId || result.data?.data?.terminalId || '';
        if (existingId) {
          backoff.markSpawned(name, existingId, session.sessionId || session.session?.sessionId || '');
          res.json(success({
            agent_name: name,
            terminal_id: existingId,
            session_id: state.sessionId,
            status: state.status,
            reattached: true,
          }, 'agent_spawn', (req as any).requestId));
          return;
        }
      }

      if (result.status !== 200) {
        state.status = 'error';
        res.status(result.status).json(
          error('SPAWN_FAILED', `Electron callback returned ${result.status}`, 'agent_spawn', (req as any).requestId)
        );
        return;
      }

      const terminalId = result.data?.terminalId || result.data?.data?.terminalId || '';
      backoff.markSpawned(name, terminalId, session.sessionId || session.session?.sessionId || '');

      res.json(success({
        agent_name: name,
        terminal_id: terminalId,
        session_id: state.sessionId,
        status: state.status,
      }, 'agent_spawn', (req as any).requestId));
    } catch (err: any) {
      const state = backoff.getOrCreate(name);
      state.status = 'error';
      const msg = err.name === 'AbortError' ? 'Electron callback timeout' : err.message;
      res.status(502).json(
        error('SPAWN_FAILED', `Spawn failed: ${msg}`, 'agent_spawn', (req as any).requestId)
      );
    }
  });

  // POST /v1/lifecycle/agents/:name/kill
  router.post('/:name/kill', async (req: Request, res: Response) => {
    const name = req.params.name as string;
    const state = backoff.get(name);

    if (!state || !state.terminalId) {
      res.status(404).json(
        error('AGENT_NOT_FOUND', `Agent ${name} is not running`, 'agent_kill', (req as any).requestId)
      );
      return;
    }

    try {
      const result = await callElectron(cfg, callbackPort, '/internal/pty/kill', {
        agentName: name,
        terminalId: state.terminalId,
      });

      state.status = 'stopped';
      state.terminalId = null;

      res.json(success({
        agent_name: name,
        status: 'stopped',
      }, 'agent_kill', (req as any).requestId));
    } catch (err: any) {
      const msg = err.name === 'AbortError' ? 'Electron callback timeout' : err.message;
      res.status(502).json(
        error('KILL_FAILED', `Kill failed: ${msg}`, 'agent_kill', (req as any).requestId)
      );
    }
  });

  // POST /v1/lifecycle/agents/:name/restart
  router.post('/:name/restart', async (req: Request, res: Response) => {
    const name = req.params.name as string;

    try {
      const state = backoff.getOrCreate(name);
      backoff.markManualRestart(name);

      // Kill if running
      if (state.terminalId) {
        try {
          await callElectron(cfg, callbackPort, '/internal/pty/kill', {
            agentName: name,
            terminalId: state.terminalId,
          });
        } catch {
          // Kill failure is non-fatal for restart
        }
        state.terminalId = null;
      }

      // Bootstrap session
      const { session } = await bootstrap(name);

      // Spawn
      const result = await callElectron(cfg, callbackPort, '/internal/pty/spawn', {
        agentName: name,
        workDir: state.workDir || undefined,
        autoReport: state.autoReport,
      });

      if (result.status !== 200) {
        state.status = 'error';
        res.status(result.status).json(
          error('RESTART_FAILED', `Electron callback returned ${result.status}`, 'agent_restart', (req as any).requestId)
        );
        return;
      }

      const terminalId = result.data?.terminalId || result.data?.data?.terminalId || '';
      backoff.markSpawned(name, terminalId, session.sessionId || session.session?.sessionId || '');

      res.json(success({
        agent_name: name,
        terminal_id: terminalId,
        session_id: state.sessionId,
        status: state.status,
        restart_count: state.restartCount,
      }, 'agent_restart', (req as any).requestId));
    } catch (err: any) {
      const msg = err.name === 'AbortError' ? 'Electron callback timeout' : err.message;
      res.status(502).json(
        error('RESTART_FAILED', `Restart failed: ${msg}`, 'agent_restart', (req as any).requestId)
      );
    }
  });

  // GET /v1/lifecycle/agents/:name/status
  router.get('/:name/status', (req: Request, res: Response) => {
    const name = req.params.name as string;
    const status = backoff.getStatus(name);

    if (!status) {
      res.status(404).json(
        error('AGENT_NOT_FOUND', `Agent ${name} not found`, 'agent_status', (req as any).requestId)
      );
      return;
    }

    res.json(success(status, 'agent_status', (req as any).requestId));
  });

  // GET /v1/lifecycle/agents — list all agents with status
  router.get('/', (req: Request, res: Response) => {
    const agents = backoff.getAll().map(state => backoff.getStatus(state.name));
    res.json(success({ agents, count: agents.length }, 'agent_list', (req as any).requestId));
  });

  // POST /internal/pty/exit — Electron reports PTY exit (internal, not proxied)
  router.post('/internal/pty-exit', (req: Request, res: Response) => {
    const { agentName, terminalId, exitCode } = req.body || {};

    if (!agentName || exitCode === undefined) {
      res.status(400).json(
        error('INVALID_REQUEST', 'agentName and exitCode required', 'pty_exit', (req as any).requestId)
      );
      return;
    }

    healthMonitor.handlePtyExit(agentName, terminalId || '', exitCode);

    res.json(success({
      agent_name: agentName,
      exit_code: exitCode,
      new_status: backoff.get(agentName)?.status || 'unknown',
    }, 'pty_exit', (req as any).requestId));
  });

  return router;
}
