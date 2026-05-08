/**
 * Team sync proxy — `GET /v1/team/sync` and `GET /v1/team/refresh`.
 *
 * Spec: idealvibe-phase1-acp-team-sync-spec-v1.md §6, §11
 *
 * Forwards the authenticated user's team list from
 * `vibe-publicapi /v1/agentmail/agents?type=team` to the desktop renderer,
 * with a 60s in-memory soft cache keyed by IDP user_id. Reuses the same
 * bearer + HMAC envelope as mailProxy.ts (single-flight refresh, X-Vibe-Via,
 * X-Vibe-User-Id) so the cloud middleware accepts both proxies identically.
 *
 * v1 ignores `project_id` on the cloud call — the cloud filter is `?type=team`
 * only. The query param is accepted for forward-compat (FE polls with it) and
 * is ignored here. See spec §13.1.
 */

import { Router, type Request, type Response } from 'express';
import { success, error } from '../response.js';
import type { Config } from '../../config.js';
import { ensureValidToken, forceRefresh, getSession } from '../auth/tokenManager.js';
import { signVibeRequest } from '../auth/vibeHmac.js';
import { extractAndMap, type MappedAgent } from '../team/mapper.js';
import * as cache from '../team/cache.js';

const AGENTMAIL_AGENTS_PATH = '/v1/agentmail/agents';
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
    'X-Vibe-User-Id': cfg.vibeUserId || '0',
    'Content-Type': 'application/json',
  };
}

async function fetchTeamFromCloud(
  cfg: Config,
): Promise<{ status: number; payload: unknown }> {
  let token = await ensureValidToken(cfg.idpUrl);
  if (!token) {
    throw new NotAuthenticatedError();
  }

  const signedPath = AGENTMAIL_AGENTS_PATH;
  const url = `${cfg.vibeApiUrl}${AGENTMAIL_AGENTS_PATH}?type=team`;

  const doFetch = async (bearer: string) => {
    const headers = buildAuthHeaders(cfg, bearer, signedPath);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), PROXY_TIMEOUT_MS);
    try {
      const res = await fetch(url, { method: 'GET', headers, signal: controller.signal });
      const text = await res.text();
      if (!text) return { status: res.status, payload: { success: res.ok, data: null } };
      try {
        return { status: res.status, payload: JSON.parse(text) };
      } catch {
        return {
          status: res.status,
          payload: {
            success: false,
            error: {
              code: 'UPSTREAM_NON_JSON',
              message: `Upstream returned non-JSON (HTTP ${res.status}): ${text.slice(0, 400)}`,
            },
          },
        };
      }
    } finally {
      clearTimeout(timeout);
    }
  };

  const first = await doFetch(token);
  if (first.status !== 401) return first;

  const refreshed = await forceRefresh(cfg.idpUrl);
  if (!refreshed) throw new NotAuthenticatedError();
  return doFetch(refreshed);
}

interface SyncResult {
  agents: MappedAgent[];
  source: 'cloud' | 'cache' | 'defaults';
  fetchedAt: string;
  warning?: string;
}

async function syncTeam(cfg: Config, forceRefreshFlag: boolean): Promise<SyncResult> {
  const session = getSession();
  if (!session) {
    throw new NotAuthenticatedError();
  }
  const userId = session.userId || '0';

  if (!forceRefreshFlag) {
    const cached = cache.getFresh(userId);
    if (cached) {
      return { agents: cached.agents, source: 'cache', fetchedAt: cached.fetchedAt };
    }
  }

  try {
    const { status, payload } = await fetchTeamFromCloud(cfg);
    if (status >= 200 && status < 300 && (payload as any)?.success) {
      const agents = extractAndMap(payload);
      const entry = cache.set(userId, agents);
      return { agents, source: 'cloud', fetchedAt: entry.fetchedAt };
    }
    // Non-2xx from cloud: fall through to stale cache if we have one.
    const stale = cache.getStale(userId);
    if (stale) {
      return {
        agents: stale.agents,
        source: 'cache',
        fetchedAt: stale.fetchedAt,
        warning: `Cloud returned HTTP ${status}; serving last-known team`,
      };
    }
    return {
      agents: [],
      source: 'defaults',
      fetchedAt: new Date().toISOString(),
      warning: `Cloud returned HTTP ${status}; no cache available`,
    };
  } catch (err: any) {
    if (err instanceof NotAuthenticatedError) throw err;
    const stale = cache.getStale(userId);
    const reason = err?.name === 'AbortError' ? 'Cloud unreachable (timeout)' : `Cloud unreachable (${err?.message || 'error'})`;
    if (stale) {
      return {
        agents: stale.agents,
        source: 'cache',
        fetchedAt: stale.fetchedAt,
        warning: `${reason}; serving last-known team`,
      };
    }
    return {
      agents: [],
      source: 'defaults',
      fetchedAt: new Date().toISOString(),
      warning: `${reason}; no cache available`,
    };
  }
}

function sendSyncError(res: Response, req: Request, err: any, op: string): void {
  if (err instanceof NotAuthenticatedError) {
    res.status(401).json(error('NOT_AUTHENTICATED', err.message, op, (req as any).requestId));
    return;
  }
  res.status(500).json(
    error('INTERNAL_ERROR', `Team sync failed: ${err?.message || err}`, op, (req as any).requestId)
  );
}

export default function teamRoutes(cfg: Config): Router {
  const router = Router();

  // GET /v1/team/sync — soft-cached team fetch (60s TTL by default)
  router.get('/sync', async (req: Request, res: Response) => {
    try {
      const forceRefreshFlag = String(req.query.force_refresh || '') === 'true';
      const result = await syncTeam(cfg, forceRefreshFlag);
      res.json(success(result, 'team_sync', (req as any).requestId));
    } catch (err: any) {
      sendSyncError(res, req, err, 'team_sync');
    }
  });

  // GET /v1/team/refresh — convenience alias for force_refresh=true
  router.get('/refresh', async (req: Request, res: Response) => {
    try {
      const result = await syncTeam(cfg, true);
      res.json(success(result, 'team_refresh', (req as any).requestId));
    } catch (err: any) {
      sendSyncError(res, req, err, 'team_refresh');
    }
  });

  return router;
}
