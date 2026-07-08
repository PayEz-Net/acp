/**
 * vsql-cache client helpers.
 *
 * vsql-cache is the .NET service that stores and streams normalized agent
 * terminal output. It lives at http://10.0.0.93:52424 and authenticates
 * internal callers with a shared container secret:
 *   Authorization: Secret <container-secret>
 *
 * User/project scope is carried in X-Vibe-* context headers so the backend
 * can resolve the authoritative context without parsing the payload.
 */

import { getCurrentUserId } from './auth';

const VSQL_CACHE_URL = process.env.VSQL_CACHE_URL || 'http://10.0.0.93:52424';
const VIBESQL_CONTAINER_SECRET = process.env.VIBESQL_CONTAINER_SECRET || '';

let reportingEnabled: boolean | null = null;
let missingConfigWarningLogged = false;

/**
 * Determine whether vsql-cache agent-output reporting is enabled.
 *
 * Reporting is enabled only when:
 *   - VIBESQL_CONTAINER_SECRET is configured (required for auth), and
 *   - VSQL_CACHE_URL is not explicitly set to an empty string.
 *
 * When VSQL_CACHE_URL is unset, the compiled default URL is used. Setting it
 * to an empty string provides an explicit opt-out toggle.
 */
export function isVsqlCacheReportingEnabled(): boolean {
  if (reportingEnabled !== null) {
    return reportingEnabled;
  }

  const hasSecret = VIBESQL_CONTAINER_SECRET.length > 0;
  const urlExplicitlyEmpty = process.env.VSQL_CACHE_URL === '';

  reportingEnabled = hasSecret && !urlExplicitlyEmpty;

  if (!reportingEnabled && !missingConfigWarningLogged) {
    const missing: string[] = [];
    if (!hasSecret) missing.push('VIBESQL_CONTAINER_SECRET');
    if (urlExplicitlyEmpty) missing.push('VSQL_CACHE_URL (empty)');
    console.warn(
      `[vsql-cache] Agent-output reporting is disabled: ${missing.join(', ')}. ` +
        'Set VIBESQL_CONTAINER_SECRET to enable PTY output streaming to vsql-cache. ' +
        'Set VSQL_CACHE_URL to override the default URL, or to an empty string to explicitly disable.',
    );
    missingConfigWarningLogged = true;
  }

  return reportingEnabled;
}

export function getVsqlCacheUrl(): string {
  return VSQL_CACHE_URL;
}

/**
 * Build the auth/context headers for a vsql-cache request.
 * Uses the shared container secret. Returns user/project context headers
 * when the values are available.
 */
export async function buildVsqlCacheAuthHeaders(
  _method: string,
  _path: string,
  context?: { userId?: string; projectId?: string },
): Promise<Record<string, string>> {
  if (!VIBESQL_CONTAINER_SECRET) {
    throw new Error('VIBESQL_CONTAINER_SECRET is not configured');
  }

  const headers: Record<string, string> = {
    Authorization: `Secret ${VIBESQL_CONTAINER_SECRET}`,
  };

  let userId = context?.userId;
  if (!userId) {
    userId = (await getCurrentUserId()) ?? undefined;
  }
  if (userId) {
    headers['X-Vibe-User-Id'] = userId;
  }
  if (context?.projectId) {
    headers['X-Vibe-Project-Id'] = context.projectId;
  }
  return headers;
}

export interface VsqlCacheOutputPayload {
  agentName: string;
  terminalId: string;
  data: string;
  provider?: string;
  projectId?: string;
  sessionId?: string;
  userId?: string;
}

/**
 * POST raw PTY output to vsql-cache.
 *
 * Returns normally on 503 Service Unavailable; the caller is expected to
 * count drops. Any other non-2xx response throws so unexpected failures
 * are still surfaced.
 */
export async function postAgentOutput(payload: VsqlCacheOutputPayload): Promise<void> {
  if (!isVsqlCacheReportingEnabled()) {
    return;
  }

  const path = '/v1/agent-output';
  const headers = await buildVsqlCacheAuthHeaders('POST', path, {
    userId: payload.userId,
    projectId: payload.projectId,
  });
  const url = `${VSQL_CACHE_URL}${path}`;

  // Work order payload contract: only raw PTY metadata, no user/project/session.
  const body = JSON.stringify({
    agentName: payload.agentName,
    terminalId: payload.terminalId,
    data: payload.data,
    provider: payload.provider,
  });

  const fetchHeaders: Record<string, string> = {
    'Content-Type': 'application/json',
    ...headers,
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: fetchHeaders,
    body,
  });

  if (res.status === 503) {
    // Backend is overloaded or down. Drop the chunk; ptyOutputReporter logs
    // the drop count. Do not throw — PTY output must never crash the desktop.
    return;
  }

  if (!res.ok) {
    throw new Error(`vsql-cache POST ${path} failed: ${res.status} ${res.statusText}`);
  }
}
