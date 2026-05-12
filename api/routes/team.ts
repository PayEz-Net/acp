import { Router, type Request, type Response } from 'express';
import { error, success } from '../response.js';
import type { Config } from '../../config.js';
import { ensureValidToken, forceRefresh, getSession } from '../auth/tokenManager.js';
import { signVibeRequest } from '../auth/vibeHmac.js';
import * as teamCache from '../team/cache.js';
import { normalizeAgents, type CloudAgent, type NormalizedAgent } from '../team/mapper.js';

// v1.5 (BAPert spec §3.2 + §3.3): upstream switched from
// /v1/agentmail/agents?type=team (legacy per-user roster) to
// /v1/agents/startup-config?project_id=X (canonical project-scoped read,
// pulls from vibe.documents/agent_profiles per Option 3 documents-canonical
// model). Cache re-keyed (userId, projectId) — single-user multi-project
// machines no longer thrash the cache on project switch.
const STARTUP_CONFIG_PATH = '/v1/agents/startup-config';
const PROXY_TIMEOUT_MS = 10_000;

class NotAuthenticatedError extends Error {
  constructor() {
    super('No active IDP session — user must log in via POST /v1/auth/login');
    this.name = 'NotAuthenticatedError';
  }
}

function buildAuthHeaders(
  cfg: Config,
  token: string,
  signedPath: string,
): Record<string, string> {
  const hmacHeaders = signVibeRequest('GET', signedPath, {
    clientId: cfg.vibeClientId,
    signingKey: cfg.vibeHmacKey,
  });
  return {
    ...hmacHeaders,
    'Authorization': `Bearer ${token}`,
    'X-Vibe-Via': 'idp-proxy',
    'Content-Type': 'application/json',
  };
}

interface CloudFetchResult {
  ok: true;
  agents: NormalizedAgent[];
}
interface CloudFetchFailure {
  ok: false;
  reason: 'auth' | 'timeout' | 'http_error' | 'parse_error';
  detail?: string;
}

async function fetchTeamFromCloud(cfg: Config, projectId: number): Promise<CloudFetchResult | CloudFetchFailure> {
  // GET /v1/agents/startup-config?project_id=X — canonical project-scoped read.
  // The HMAC signed path includes the query string so the cloud-side signature
  // verification matches our exact request URL.
  const signedPath = `${STARTUP_CONFIG_PATH}?project_id=${projectId}`;
  const url = `${cfg.vibeApiUrl}${signedPath}`;

  let token = await ensureValidToken(cfg.idpUrl);
  if (!token) {
    return { ok: false, reason: 'auth' };
  }

  const doFetch = async (bearer: string): Promise<{ status: number; body: any; raw: string }> => {
    const headers = buildAuthHeaders(cfg, bearer, signedPath);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), PROXY_TIMEOUT_MS);
    try {
      const res = await fetch(url, { method: 'GET', headers, signal: controller.signal });
      const raw = await res.text();
      let body: any = null;
      try { body = raw ? JSON.parse(raw) : null; } catch { /* leave null */ }
      return { status: res.status, body, raw };
    } finally {
      clearTimeout(timeout);
    }
  };

  let attempt: { status: number; body: any; raw: string };
  try {
    attempt = await doFetch(token);
  } catch (err: any) {
    return { ok: false, reason: err?.name === 'AbortError' ? 'timeout' : 'http_error', detail: err?.message };
  }

  if (attempt.status === 401) {
    const refreshed = await forceRefresh(cfg.idpUrl);
    if (!refreshed) return { ok: false, reason: 'auth' };
    try {
      attempt = await doFetch(refreshed);
    } catch (err: any) {
      return { ok: false, reason: err?.name === 'AbortError' ? 'timeout' : 'http_error', detail: err?.message };
    }
  }

  if (attempt.status < 200 || attempt.status >= 300) {
    return { ok: false, reason: 'http_error', detail: `HTTP ${attempt.status}` };
  }

  const cloudAgents: CloudAgent[] | undefined = attempt.body?.data?.agents;
  if (!Array.isArray(cloudAgents)) {
    return { ok: false, reason: 'parse_error', detail: 'response missing data.agents array' };
  }

  return { ok: true, agents: normalizeAgents(cloudAgents) };
}

interface SyncPayload {
  agents: NormalizedAgent[];
  source: 'cloud' | 'cache' | 'defaults';
  fetchedAt: string;
  warning?: string;
}

// §3.3 universal-pair fallback (BAPert Decision 3a): when cloud unreachable
// + no cache for (userId, projectId), return the universal pair (BAPert + QAPert)
// so the desktop renders SOMETHING useful instead of an empty grid. Renderer
// surfaces this with a "Working offline with default team" banner driven by
// the wrapper-level `source: 'defaults'` signal — per-agent flag was redundant
// (N1 amendment, QAPert msg 961 F1) and removed.
const UNIVERSAL_PAIR_FALLBACK: NormalizedAgent[] = [
  { id: 0, name: 'BAPert', displayName: 'BAPert', isActive: true },
  { id: 0, name: 'QAPert', displayName: 'QAPert', isActive: true },
];

async function syncTeam(cfg: Config, projectId: number, force: boolean): Promise<SyncPayload | { needsAuth: true }> {
  const session = getSession();
  if (!session) return { needsAuth: true };
  const userId = session.userId;

  if (!force) {
    const fresh = teamCache.getFresh(userId, projectId);
    if (fresh) {
      return { agents: fresh.agents, source: 'cache', fetchedAt: fresh.fetchedAt };
    }
  }

  const cloud = await fetchTeamFromCloud(cfg, projectId);
  if (cloud.ok) {
    const entry = teamCache.set(userId, projectId, cloud.agents);
    return { agents: cloud.agents, source: 'cloud', fetchedAt: entry.fetchedAt };
  }

  if (cloud.reason === 'auth') {
    return { needsAuth: true };
  }

  // Cloud unreachable — fall back to last cached entry for this (userId, projectId), regardless of TTL.
  const stale = teamCache.getStale(userId, projectId);
  if (stale) {
    return {
      agents: stale.agents,
      source: 'cache',
      fetchedAt: stale.fetchedAt,
      warning: `Cloud unreachable (${cloud.reason}); serving last-known team`,
    };
  }

  // §3.3 Decision 3a: universal pair when cloud-unreachable + cache-absent.
  return {
    agents: UNIVERSAL_PAIR_FALLBACK,
    source: 'defaults',
    fetchedAt: new Date().toISOString(),
    warning: `Cloud unreachable (${cloud.reason}) and no cached team available`,
  };
}

function parseProjectId(req: Request): { ok: true; value: number } | { ok: false; message: string } {
  const raw = req.query.project_id;
  if (raw === undefined || raw === null || raw === '') {
    return { ok: false, message: 'project_id query parameter is required (positive integer)' };
  }
  const n = parseInt(String(raw), 10);
  if (!Number.isFinite(n) || n <= 0) {
    return { ok: false, message: 'project_id must be a positive integer' };
  }
  return { ok: true, value: n };
}

export default function teamRoutes(cfg: Config): Router {
  const router = Router();

  router.get('/sync', async (req: Request, res: Response) => {
    const projectId = parseProjectId(req);
    if (!projectId.ok) {
      res.status(400).json(error('MISSING_PROJECT_ID', projectId.message, 'team_sync', (req as any).requestId));
      return;
    }
    const force = String(req.query.force_refresh || '').toLowerCase() === 'true';
    try {
      const result = await syncTeam(cfg, projectId.value, force);
      if ('needsAuth' in result) {
        res.status(401).json(error('NOT_AUTHENTICATED', 'No active IDP session', 'team_sync', (req as any).requestId));
        return;
      }
      res.json(success(result, 'team_sync', (req as any).requestId));
    } catch (err: any) {
      if (err instanceof NotAuthenticatedError) {
        res.status(401).json(error('NOT_AUTHENTICATED', err.message, 'team_sync', (req as any).requestId));
        return;
      }
      res.status(502).json(error('TEAM_SYNC_ERROR', `Team sync failed: ${err?.message || err}`, 'team_sync', (req as any).requestId));
    }
  });

  router.get('/refresh', async (req: Request, res: Response) => {
    const projectId = parseProjectId(req);
    if (!projectId.ok) {
      res.status(400).json(error('MISSING_PROJECT_ID', projectId.message, 'team_refresh', (req as any).requestId));
      return;
    }
    try {
      const result = await syncTeam(cfg, projectId.value, true);
      if ('needsAuth' in result) {
        res.status(401).json(error('NOT_AUTHENTICATED', 'No active IDP session', 'team_refresh', (req as any).requestId));
        return;
      }
      res.json(success(result, 'team_refresh', (req as any).requestId));
    } catch (err: any) {
      res.status(502).json(error('TEAM_REFRESH_ERROR', `Team refresh failed: ${err?.message || err}`, 'team_refresh', (req as any).requestId));
    }
  });

  return router;
}
