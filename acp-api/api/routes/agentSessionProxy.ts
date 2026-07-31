import { Router, type Request, type Response } from 'express';
import { error } from '../response.js';
import type { Config } from '../../config.js';
import { ensureValidToken, forceRefresh, getSession, requireTokenClientId } from '../auth/tokenManager.js';
import * as projectsCache from '../projects/cache.js';

const AGENTSESSION_BASE = '/v1/sessions';
const PROXY_TIMEOUT_MS = 10_000;

export class NotAuthenticatedError extends Error {
  constructor() {
    super('No active IDP session — user must log in via POST /v1/auth/login');
    this.name = 'NotAuthenticatedError';
  }
}

function buildAuthHeaders(_cfg: Config, token: string): Record<string, string> {
  return {
    'Authorization': `Bearer ${token}`,
    'X-Client-Id': requireTokenClientId(token),
    'X-Vibe-Via': 'idp-proxy',
    'Content-Type': 'application/json',
  };
}

function resolveCurrentProjectId(): number | null {
  const session = getSession();
  if (!session?.userId) return null;
  const entry = projectsCache.current.getFresh(session.userId)
    ?? projectsCache.current.getStale(session.userId);
  return entry?.current_project_id ?? null;
}

async function proxyToCloud(
  cfg: Config,
  path: string,
  method: 'GET' | 'POST',
  body?: unknown,
): Promise<{ status: number; data: unknown }> {
  const url = `${cfg.vibeApiUrl}${AGENTSESSION_BASE}${path}`;
  const token = await ensureValidToken(cfg.idpUrl, 'ensureValidToken@agent-session');
  if (!token) {
    throw new NotAuthenticatedError();
  }

  const doFetch = async (bearer: string): Promise<{ status: number; data: unknown }> => {
    const headers = buildAuthHeaders(cfg, bearer);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), PROXY_TIMEOUT_MS);
    try {
      const init: RequestInit = {
        method,
        headers,
        signal: controller.signal,
      };
      if (body && method === 'POST') {
        init.body = JSON.stringify(body);
      }
      const res = await fetch(url, init);
      const text = await res.text();
      if (!text) {
        return { status: res.status, data: { success: res.ok, data: null } };
      }
      try {
        return { status: res.status, data: JSON.parse(text) };
      } catch {
        return {
          status: res.status,
          data: {
            success: false,
            error: {
              code: 'UPSTREAM_NON_JSON',
              message: `Upstream returned non-JSON body (HTTP ${res.status}): ${text.slice(0, 400)}`,
            },
          },
        };
      }
    } finally {
      clearTimeout(timeout);
    }
  };

  const firstAttempt = await doFetch(token);
  if (firstAttempt.status !== 401) {
    return firstAttempt;
  }
  const refreshed = await forceRefresh(cfg.idpUrl, 'forceRefresh-on-401@agent-session');
  if (!refreshed) {
    throw new NotAuthenticatedError();
  }
  return doFetch(refreshed);
}

function sendProxyError(res: Response, req: Request, err: any, operation: string): void {
  if (err instanceof NotAuthenticatedError) {
    res.status(401).json(error('NOT_AUTHENTICATED', err.message, operation, (req as any).requestId));
    return;
  }
  const msg = err.name === 'AbortError' ? 'Upstream timeout (10s)' : err.message;
  res.status(502).json(error('PROXY_ERROR', `Agent session proxy failed: ${msg}`, operation, (req as any).requestId));
}

export default function agentSessionProxyRoutes(cfg: Config): Router {
  const router = Router();

  // POST /v1/agent-sessions/start -> cloud /v1/sessions/start
  // The desktop supplies project_id — the machine-local project the agent was
  // spawned under — and that wins. The cache fallback below is a per-user slot
  // shared by every machine on the account, so it can carry another machine's
  // project; it is only used when the caller supplied nothing.
  router.post('/start', async (req: Request, res: Response) => {
    try {
      const { agent_id, project_id } = req.body || {};
      if (typeof agent_id !== 'number') {
        res.status(400).json(error('VALIDATION_ERROR', 'agent_id is required and must be a number', 'agent_session_start', (req as any).requestId));
        return;
      }
      // null is "no project" over the wire — JSON callers cannot send undefined,
      // and `project_id: state.projectId ?? null` is the idiom used elsewhere in
      // this API. Treat it as absent (fall back), not as a 400.
      if (project_id !== undefined && project_id !== null && typeof project_id !== 'number') {
        res.status(400).json(error('VALIDATION_ERROR', 'project_id must be a number or null when provided', 'agent_session_start', (req as any).requestId));
        return;
      }
      const projectId = typeof project_id === 'number' ? project_id : resolveCurrentProjectId();
      const forwardBody: Record<string, unknown> = { agent_id };
      if (projectId != null) {
        forwardBody.project_id = projectId;
        if (typeof project_id !== 'number') {
          console.warn(`[agentSessionProxy] POST /start: caller sent no project_id — falling back to shared current-project slot ${projectId}`);
        }
      } else {
        console.warn('[agentSessionProxy] POST /start: no project_id from caller and no current_project_id in cache — forwarding without it');
      }
      const result = await proxyToCloud(cfg, '/start', 'POST', forwardBody);
      res.status(result.status).json(result.data);
    } catch (err: any) {
      sendProxyError(res, req, err, 'agent_session_start');
    }
  });

  // POST /v1/agent-sessions/:id/heartbeat -> cloud /v1/sessions/:id/heartbeat
  router.post('/:id/heartbeat', async (req: Request, res: Response) => {
    try {
      const id = parseInt(String(req.params.id), 10);
      if (!Number.isFinite(id)) {
        res.status(400).json(error('VALIDATION_ERROR', 'id must be an integer', 'agent_session_heartbeat', (req as any).requestId));
        return;
      }
      const result = await proxyToCloud(cfg, `/${id}/heartbeat`, 'POST');
      res.status(result.status).json(result.data);
    } catch (err: any) {
      sendProxyError(res, req, err, 'agent_session_heartbeat');
    }
  });

  // POST /v1/agent-sessions/:id/end -> cloud /v1/sessions/:id/end?reason=...
  router.post('/:id/end', async (req: Request, res: Response) => {
    try {
      const id = parseInt(String(req.params.id), 10);
      if (!Number.isFinite(id)) {
        res.status(400).json(error('VALIDATION_ERROR', 'id must be an integer', 'agent_session_end', (req as any).requestId));
        return;
      }
      const reason = typeof req.query.reason === 'string' ? req.query.reason : 'normal';
      const result = await proxyToCloud(cfg, `/${id}/end?reason=${encodeURIComponent(reason)}`, 'POST');
      res.status(result.status).json(result.data);
    } catch (err: any) {
      sendProxyError(res, req, err, 'agent_session_end');
    }
  });

  return router;
}
