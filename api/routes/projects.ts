/**
 * Wave 2 + post-rename: cloud proxy for `/v1/projects` + current-project pointer.
 *
 * Local-Map echo retired. acp-api now proxies vibe-publicapi via the bearer
 * + HMAC envelope shared with team.ts / mailProxy.ts. Cloud surface (post
 * DotNetPert msg 1008 rename + archive guard, image 661332fe30ac):
 *
 *   GET  /v1/projects?activeOnly=true&search=...        → list
 *   GET  /v1/projects/:id                               → detail + members
 *   GET  /v1/users/me/current-project                   → focus pointer
 *   PUT  /v1/users/me/current-project { project_id }    → focus writeback
 *
 * FE-facing surface mirrors the cloud rename:
 *
 *   GET  /v1/projects/sync                              → unified envelope
 *                                                          (projects[] +
 *                                                          current_project_id +
 *                                                          current_project_state +
 *                                                          source)
 *   GET  /v1/projects                                   → list passthrough
 *   GET  /v1/projects/:id                               → detail passthrough
 *   GET  /v1/projects/current                           → focus pointer (200 always)
 *   POST /v1/projects/current { project_id }            → focus writeback
 *                                                          (POST→PUT bridge to cloud)
 *
 * Three-state focus enum is `stored | unset | empty` (spec §5.4):
 *   - 'stored' → render normally
 *   - 'unset'  → first-boot prompt picker (no auto-load — feedback_no_unjustified_fallback)
 *   - 'empty'  → create-CTA pointing at idealvibe.online
 *
 * Archive guard (Wave A.1 rename ship): PUT to is_active=false project →
 * 400 PROJECT_ARCHIVED; soft-deleted → 404 PROJECT_NOT_FOUND; cross-tenant →
 * 403 PROJECT_FORBIDDEN. These error codes flow through unchanged from cloud.
 *
 * POST /, PATCH /:id, DELETE /:id → 410 GONE (CRUD lives on idealvibe per
 * spec §3 non-goals).
 */

import { Router, type Request, type Response } from 'express';
import { success, error } from '../response.js';
import type { Config } from '../../config.js';
import type { LocalEventBus } from '../sse/localEventBus.js';
import { ensureValidToken, forceRefresh, getSession } from '../auth/tokenManager.js';
import { signVibeRequest } from '../auth/vibeHmac.js';
import {
  extractAndMapList,
  extractAndMapCurrent,
  extractAndMapDetail,
  mapCloudProject,
  type MappedProject,
  type CurrentProjectState,
} from '../projects/mapper.js';
import * as cache from '../projects/cache.js';

const PROXY_TIMEOUT_MS = 10_000;
const CLOUD_PROJECTS_PATH = '/v1/projects';
const CLOUD_CURRENT_PROJECT_PATH = '/v1/users/me/current-project';

class NotAuthenticatedError extends Error {
  constructor() {
    super('No active IDP session — user must log in via POST /v1/auth/login');
    this.name = 'NotAuthenticatedError';
  }
}

function buildAuthHeaders(
  cfg: Config,
  token: string,
  method: 'GET' | 'POST' | 'PUT',
  signedPath: string,
): Record<string, string> {
  const hmacHeaders = signVibeRequest(method, signedPath, {
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

function buildQueryString(query: Record<string, unknown> | undefined): string {
  if (!query) return '';
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined && v !== null && k !== 'force_refresh') {
      params.set(k, String(v));
    }
  }
  const qs = params.toString();
  return qs ? `?${qs}` : '';
}

async function callCloud(
  cfg: Config,
  method: 'GET' | 'POST' | 'PUT',
  path: string,
  query?: Record<string, unknown>,
  body?: unknown,
): Promise<{ status: number; payload: unknown }> {
  let token = await ensureValidToken(cfg.idpUrl);
  if (!token) throw new NotAuthenticatedError();

  const qs = buildQueryString(query);
  const url = `${cfg.vibeApiUrl}${path}${qs}`;
  const signedPath = path; // HMAC signs path-only, never query

  const doFetch = async (bearer: string): Promise<{ status: number; payload: unknown }> => {
    const headers = buildAuthHeaders(cfg, bearer, method, signedPath);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), PROXY_TIMEOUT_MS);
    try {
      const opts: RequestInit = { method, headers, signal: controller.signal };
      if (body !== undefined && method !== 'GET') {
        opts.body = JSON.stringify(body);
      }
      const res = await fetch(url, opts);
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

function sendProxyError(res: Response, req: Request, err: any, op: string): void {
  if (err instanceof NotAuthenticatedError) {
    res.status(401).json(error('NOT_AUTHENTICATED', err.message, op, (req as any).requestId));
    return;
  }
  const reason = err?.name === 'AbortError' ? 'Upstream timeout (10s)' : err?.message || String(err);
  res.status(502).json(error('PROXY_ERROR', `Project proxy failed: ${reason}`, op, (req as any).requestId));
}

interface ListResult {
  projects: MappedProject[];
  source: 'cloud' | 'cache' | 'defaults';
  fetchedAt: string;
  warning?: string;
}

interface CurrentResult {
  current_project_id: number | null;
  project: MappedProject | null;
  current_project_state: CurrentProjectState;
  source: 'cloud' | 'cache' | 'defaults';
  fetchedAt: string;
  warning?: string;
}

async function readList(
  cfg: Config,
  userId: string,
  query: Record<string, unknown>,
  forceRefreshFlag: boolean,
): Promise<ListResult> {
  if (!forceRefreshFlag) {
    const fresh = cache.list.getFresh(userId);
    if (fresh) return { projects: fresh.projects, source: 'cache', fetchedAt: fresh.fetchedAt };
  }
  try {
    const effective: Record<string, unknown> = { activeOnly: 'true', ...query };
    const { status, payload } = await callCloud(cfg, 'GET', CLOUD_PROJECTS_PATH, effective);
    if (status >= 200 && status < 300 && (payload as any)?.success) {
      const projects = extractAndMapList(payload);
      const entry = cache.list.set(userId, projects);
      return { projects, source: 'cloud', fetchedAt: entry.fetchedAt };
    }
    const stale = cache.list.getStale(userId);
    if (stale) {
      return {
        projects: stale.projects,
        source: 'cache',
        fetchedAt: stale.fetchedAt,
        warning: `Cloud returned HTTP ${status}; serving last-known list`,
      };
    }
    return {
      projects: [],
      source: 'defaults',
      fetchedAt: new Date().toISOString(),
      warning: `Cloud returned HTTP ${status}; no cache available`,
    };
  } catch (err: any) {
    if (err instanceof NotAuthenticatedError) throw err;
    const stale = cache.list.getStale(userId);
    const reason = err?.name === 'AbortError' ? 'Cloud unreachable (timeout)' : `Cloud unreachable (${err?.message || 'error'})`;
    if (stale) {
      return {
        projects: stale.projects,
        source: 'cache',
        fetchedAt: stale.fetchedAt,
        warning: `${reason}; serving last-known list`,
      };
    }
    return {
      projects: [],
      source: 'defaults',
      fetchedAt: new Date().toISOString(),
      warning: `${reason}; no cache available`,
    };
  }
}

async function readCurrent(
  cfg: Config,
  userId: string,
  forceRefreshFlag: boolean,
): Promise<CurrentResult> {
  if (!forceRefreshFlag) {
    const fresh = cache.current.getFresh(userId);
    if (fresh) {
      return {
        current_project_id: fresh.current_project_id,
        project: fresh.project,
        current_project_state: fresh.current_project_state,
        source: 'cache',
        fetchedAt: fresh.fetchedAt,
      };
    }
  }
  try {
    const { status, payload } = await callCloud(cfg, 'GET', CLOUD_CURRENT_PROJECT_PATH);
    if (status >= 200 && status < 300 && (payload as any)?.success) {
      const mapped = extractAndMapCurrent(payload);
      const entry = cache.current.set(userId, mapped);
      return {
        current_project_id: entry.current_project_id,
        project: entry.project,
        current_project_state: entry.current_project_state,
        source: 'cloud',
        fetchedAt: entry.fetchedAt,
      };
    }
    const stale = cache.current.getStale(userId);
    if (stale) {
      return {
        current_project_id: stale.current_project_id,
        project: stale.project,
        current_project_state: stale.current_project_state,
        source: 'cache',
        fetchedAt: stale.fetchedAt,
        warning: `Cloud returned HTTP ${status}; serving last-known current`,
      };
    }
    // No cache, cloud unhappy → conservative default: 'unset'. The FE will
    // render the first-boot prompt; that's the safe assumption when we
    // genuinely don't know whether a row exists. Better than silently
    // assuming 'empty' (would show create-CTA over a real-but-unreachable
    // user account).
    return {
      current_project_id: null,
      project: null,
      current_project_state: 'unset',
      source: 'defaults',
      fetchedAt: new Date().toISOString(),
      warning: `Cloud returned HTTP ${status}; no cache available`,
    };
  } catch (err: any) {
    if (err instanceof NotAuthenticatedError) throw err;
    const stale = cache.current.getStale(userId);
    const reason = err?.name === 'AbortError' ? 'Cloud unreachable (timeout)' : `Cloud unreachable (${err?.message || 'error'})`;
    if (stale) {
      return {
        current_project_id: stale.current_project_id,
        project: stale.project,
        current_project_state: stale.current_project_state,
        source: 'cache',
        fetchedAt: stale.fetchedAt,
        warning: `${reason}; serving last-known current`,
      };
    }
    return {
      current_project_id: null,
      project: null,
      current_project_state: 'unset',
      source: 'defaults',
      fetchedAt: new Date().toISOString(),
      warning: `${reason}; no cache available`,
    };
  }
}

export default function projectRoutes(eventBus: LocalEventBus, cfg: Config): Router {
  const router = Router();

  // GET /v1/projects/sync — unified envelope.
  // Single round-trip from FE that wants the consolidated view. The two
  // internal reads share the cache layer, so the cloud sees at most two
  // calls regardless of which legacy endpoint the FE hits.
  router.get('/sync', async (req: Request, res: Response) => {
    try {
      const session = getSession();
      if (!session) throw new NotAuthenticatedError();
      const userId = session.userId || '0';
      const forceRefreshFlag = String(req.query.force_refresh || '') === 'true';

      const [listR, currentR] = await Promise.all([
        readList(cfg, userId, req.query as Record<string, unknown>, forceRefreshFlag),
        readCurrent(cfg, userId, forceRefreshFlag),
      ]);

      // Combined source resolution: if either side is cache/defaults,
      // surface that on the wire (the FE banner pattern). 'cloud' only when
      // both succeed live.
      const combinedSource: 'cloud' | 'cache' | 'defaults' =
        listR.source === 'cloud' && currentR.source === 'cloud'
          ? 'cloud'
          : listR.source === 'defaults' || currentR.source === 'defaults'
            ? 'defaults'
            : 'cache';
      const warning = listR.warning ?? currentR.warning;

      res.json(success(
        {
          projects: listR.projects,
          current_project_id: currentR.current_project_id,
          current_project_state: currentR.current_project_state,
          source: combinedSource,
          fetchedAt: listR.fetchedAt,
          ...(warning ? { warning } : {}),
        },
        'projects_sync',
        (req as any).requestId,
      ));
    } catch (err: any) {
      sendProxyError(res, req, err, 'projects_sync');
    }
  });

  // GET /v1/projects — list of projects for authed developer.
  router.get('/', async (req: Request, res: Response) => {
    try {
      const session = getSession();
      if (!session) throw new NotAuthenticatedError();
      const userId = session.userId || '0';
      const forceRefreshFlag = String(req.query.force_refresh || '') === 'true';
      const result = await readList(cfg, userId, req.query as Record<string, unknown>, forceRefreshFlag);
      res.json(success(
        {
          projects: result.projects,
          source: result.source,
          fetchedAt: result.fetchedAt,
          ...(result.warning ? { warning: result.warning } : {}),
        },
        'projects_list',
        (req as any).requestId,
      ));
    } catch (err: any) {
      sendProxyError(res, req, err, 'projects_list');
    }
  });

  // GET /v1/projects/current — current-project pointer.
  // Always returns 200 (no 404 on null project). FE reads
  // `current_project_state` and renders accordingly.
  router.get('/current', async (req: Request, res: Response) => {
    try {
      const session = getSession();
      if (!session) throw new NotAuthenticatedError();
      const userId = session.userId || '0';
      const forceRefreshFlag = String(req.query.force_refresh || '') === 'true';
      const result = await readCurrent(cfg, userId, forceRefreshFlag);
      res.json(success(
        {
          project: result.project,
          current_project_id: result.current_project_id,
          current_project_state: result.current_project_state,
          source: result.source,
          fetchedAt: result.fetchedAt,
          ...(result.warning ? { warning: result.warning } : {}),
        },
        'project_current',
        (req as any).requestId,
      ));
    } catch (err: any) {
      sendProxyError(res, req, err, 'project_current');
    }
  });

  // POST /v1/projects/current { project_id } — bridge to cloud PUT.
  // Cloud-side error codes (PROJECT_ARCHIVED 400, PROJECT_NOT_FOUND 404,
  // PROJECT_FORBIDDEN 403) flow through with their original HTTP status.
  router.post('/current', async (req: Request, res: Response) => {
    try {
      const session = getSession();
      if (!session) throw new NotAuthenticatedError();
      const userId = session.userId || '0';
      const { project_id } = req.body || {};
      if (project_id !== null && (project_id === undefined || isNaN(parseInt(String(project_id), 10)))) {
        res.status(400).json(error('VALIDATION_ERROR', 'project_id required (integer or null to clear)', 'project_set_current', (req as any).requestId));
        return;
      }
      const idForCloud = project_id === null ? null : parseInt(String(project_id), 10);

      // POST → PUT bridge to cloud.
      const { status, payload } = await callCloud(cfg, 'PUT', CLOUD_CURRENT_PROJECT_PATH, undefined, { project_id: idForCloud });

      // Pass cloud error codes through with their original HTTP status so
      // FE switches on the real archive guard / forbidden / not-found
      // distinctions.
      if (status === 400 || status === 403 || status === 404) {
        const upstreamError = (payload as any)?.error ?? {};
        const code = upstreamError.code || (status === 400 ? 'BAD_REQUEST' : status === 403 ? 'PROJECT_FORBIDDEN' : 'PROJECT_NOT_FOUND');
        const message = upstreamError.message || `Cloud returned HTTP ${status}`;
        res.status(status).json(error(code, message, 'project_set_current', (req as any).requestId));
        return;
      }
      if (status < 200 || status >= 300 || !(payload as any)?.success) {
        const upstreamMsg = (payload as any)?.error?.message || `Cloud writeback returned HTTP ${status}`;
        res.status(502).json(error('PROXY_ERROR', upstreamMsg, 'project_set_current', (req as any).requestId));
        return;
      }

      // Invalidate current-pointer cache so the next sync sees the change
      // immediately. List cache stays — switching focus doesn't change
      // membership.
      cache.current.clear(userId);

      const data = (payload as any).data ?? {};
      const cloudProject = data.project ?? null;
      const current_project_id = typeof data.current_project_id === 'number' ? data.current_project_id : (idForCloud ?? null);

      // SSE emit — preserves existing FE listeners (useAcpSse →
      // projectStore.handleProjectSwitched → syncTeam force-refresh).
      if (current_project_id) {
        eventBus.emit({
          event: 'project-switched',
          data: {
            project_id: current_project_id,
            project_name: cloudProject?.name || '',
          },
        });
      }

      // Reuse the canonical mapper so writeback responses carry the same
      // Wave A.1 enriched shape (12 attribute fields + counts) as GET reads.
      // Hand-rolled inline mapping was missing fields and would drift.
      const mapped = cloudProject ? mapCloudProject(cloudProject) : null;
      res.json(success(
        {
          project: mapped,
          current_project_id,
          current_project_state: 'stored' as CurrentProjectState,
        },
        'project_set_current',
        (req as any).requestId,
      ));
    } catch (err: any) {
      sendProxyError(res, req, err, 'project_set_current');
    }
  });

  // POST /v1/projects — CREATE retired (lives on idealvibe).
  router.post('/', (req: Request, res: Response) => {
    res.status(410).json(error(
      'GONE',
      'Project create lives on idealvibe.online/dashboard/projects — ACP is read+switch only in Phase 1',
      'project_create',
      (req as any).requestId,
    ));
  });

  // PATCH /v1/projects/:id — UPDATE retired.
  router.patch('/:id', (req: Request, res: Response) => {
    res.status(410).json(error(
      'GONE',
      'Project update lives on idealvibe.online/dashboard/projects — ACP is read+switch only in Phase 1',
      'project_update',
      (req as any).requestId,
    ));
  });

  // DELETE /v1/projects/:id — DELETE retired.
  router.delete('/:id', (req: Request, res: Response) => {
    res.status(410).json(error(
      'GONE',
      'Project delete lives on idealvibe.online/dashboard/projects — ACP is read+switch only in Phase 1',
      'project_delete',
      (req as any).requestId,
    ));
  });

  // GET /v1/projects/:id — proxy to cloud detail (project + members).
  router.get('/:id', async (req: Request, res: Response) => {
    try {
      const session = getSession();
      if (!session) throw new NotAuthenticatedError();
      const id = parseInt(req.params.id as string, 10);
      if (isNaN(id)) {
        res.status(400).json(error('VALIDATION_ERROR', 'id must be an integer', 'project_get', (req as any).requestId));
        return;
      }
      const { status, payload } = await callCloud(cfg, 'GET', `${CLOUD_PROJECTS_PATH}/${id}`);
      if (status === 403) {
        res.status(403).json(error('PROJECT_FORBIDDEN', 'Cross-tenant or cross-user project access denied', 'project_get', (req as any).requestId));
        return;
      }
      if (status === 404) {
        res.status(404).json(error('NOT_FOUND', 'Project not found', 'project_get', (req as any).requestId));
        return;
      }
      if (status < 200 || status >= 300 || !(payload as any)?.success) {
        const upstreamMsg = (payload as any)?.error?.message || `Cloud returned HTTP ${status}`;
        res.status(502).json(error('PROXY_ERROR', upstreamMsg, 'project_get', (req as any).requestId));
        return;
      }
      const detail = extractAndMapDetail(payload);
      res.json(success(detail, 'project_get', (req as any).requestId));
    } catch (err: any) {
      sendProxyError(res, req, err, 'project_get');
    }
  });

  return router;
}
