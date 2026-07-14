/**
 * Agent-output reporting client (PayEzVibe API mediated).
 *
 * Raw PTY output is forwarded to the PayEzVibe API at VIBE_API_URL, which
 * authenticates the user, resolves the active agent session, and forwards
 * normalized output to the internal cache service. The desktop never holds
 * the backend cache container secret.
 */

import { getAccessToken, getCurrentUserId } from './auth';
import { VIBE_API_URL } from './env';

/**
 * Build the auth/context headers for a PayEzVibe API agent-output request.
 * Uses the current user's bearer token.
 */
export async function buildVsqlCacheAuthHeaders(
  _method: string,
  _path: string,
  context?: { userId?: string; projectId?: string },
): Promise<Record<string, string>> {
  const token = await getAccessToken();
  if (!token) {
    throw new Error('No authenticated user token available');
  }

  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
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

/**
 * Default role-to-capability map used by the IDP. The desktop mirrors this so
 * it can decide whether to start agent sessions even when the raw JWT's
 * `capabilities` claim is stale/missing a role-derived capability.
 */
const DEFAULT_ROLE_CAPABILITIES: Record<string, string[]> = {
  vibe_agents_user: ['agent_mail', 'agent_terminal_output'],
  vibe_agent_system_user: ['agent_mail', 'agent_terminal_output'],
  vibe_app_admin: ['agent_mail', 'vibe_admin', 'agent_terminal_output'],
};

function parseJwtClaimArray(payload: Record<string, unknown>, claim: string): string[] {
  const raw = payload[claim];
  if (Array.isArray(raw)) return raw.filter((r): r is string => typeof r === 'string');
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (trimmed.startsWith('[')) {
      try {
        const parsed = JSON.parse(trimmed);
        if (Array.isArray(parsed)) return parsed.filter((r): r is string => typeof r === 'string');
      } catch {
        // fall through to CSV
      }
    }
    return trimmed.split(',').map((s) => s.trim()).filter(Boolean);
  }
  return [];
}

/**
 * Check whether the current user's JWT contains a given capability claim.
 * Capabilities are read directly from the token and also derived from the
 * user's roles, matching the server-side RoleCapabilityResolver behavior.
 */
export async function hasCapability(capability: string): Promise<boolean> {
  const token = await getAccessToken();
  if (!token) return false;
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()) as Record<string, unknown>;
    const caps = new Set<string>();

    // Direct claim (server-issued)
    for (const c of parseJwtClaimArray(payload, 'capabilities')) {
      caps.add(c);
    }

    // Role-derived (mirrors IdentityBearerTokenService / JwtClaimExtractor)
    for (const role of parseJwtClaimArray(payload, 'roles')) {
      for (const derived of DEFAULT_ROLE_CAPABILITIES[role] ?? []) {
        caps.add(derived);
      }
    }

    return caps.has(capability);
  } catch {
    return false;
  }
}

export interface VsqlCacheOutputPayload {
  agentName: string;
  terminalId: string;
  data: string;
  provider?: string;
  projectId?: string;
  sessionId?: string;
  sessionToken?: string;
  userId?: string;
}

/**
 * POST raw PTY output to the PayEzVibe API.
 *
 * Returns normally on 503 Service Unavailable; the caller is expected to
 * count drops. Any other non-2xx response throws so unexpected failures
 * are still surfaced.
 */
export async function postAgentOutput(payload: VsqlCacheOutputPayload): Promise<void> {
  const path = '/v1/agent-output';
  const headers = await buildVsqlCacheAuthHeaders('POST', path, {
    userId: payload.userId,
    projectId: payload.projectId,
  });
  const url = `${VIBE_API_URL}${path}`;

  const body = JSON.stringify({
    agentName: payload.agentName,
    terminalId: payload.terminalId,
    data: payload.data,
    provider: payload.provider,
    sessionToken: payload.sessionToken,
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
    // Backend cache is overloaded or down. Drop the chunk; ptyOutputReporter logs
    // the drop count. Do not throw — PTY output must never crash the desktop.
    return;
  }

  if (!res.ok) {
    throw new Error(`vibe-api POST ${path} failed: ${res.status} ${res.statusText}`);
  }
}
