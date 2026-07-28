/**
 * ACP API Client for Main Process
 *
 * All API calls go through ACP API (the communications hub).
 * Auth, Vibe API calls, everything.
 */

import { IDP_CLIENT_APP, IDP_CLIENT_APP_HEADER } from '../shared/idp-config';

export interface RegisterPtyTerminalPayload {
  agentName: string;
  terminalId: string;
  projectId: number;
  provider?: string;
}
import { getLocalSecret } from './api-server';

export const ACP_API_URL = process.env.ACP_API_URL || 'http://127.0.0.1:3001';

interface AcpApiError {
  code: string;
  message: string;
}

interface LoginResponse {
  success: boolean;
  result?: {
    user_id: string;
    email: string;
    expires_in: number;
  };
  error?: AcpApiError;
}

interface StatusResponse {
  success: boolean;
  data?: {
    is_authenticated: boolean;
    user?: {
      user_id: string;
      email: string;
    } | null;
    expires_at?: string;
  };
}

export async function acpApiCall(endpoint: string, options: RequestInit = {}): Promise<any> {
  const url = `${ACP_API_URL}${endpoint}`;
  
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    [IDP_CLIENT_APP_HEADER]: IDP_CLIENT_APP,
    ...(options.headers as Record<string, string> || {}),
  };

  // Add Bearer auth for internal calls. Resolve the secret AT CALL TIME from the
  // live spawned-sidecar secret (getLocalSecret), NOT a module-load capture of
  // process.env. THE BUG (Jon/Ryan "no backend" post-OAuth, sidecar IS up): in a
  // packaged build api-server generates the secret at runtime, keeps it in memory
  // (getLocalSecret), and injects it ONLY into the spawned sidecar's env — it is
  // NEVER on this main process's process.env, so the old module-load
  // `process.env.ACP_LOCAL_SECRET || ''` captured '' and sent NO Bearer. The local
  // sidecar's X-ACP-Agent paths (mail/kanban) still 200, and /v1/auth/external-session
  // is PUBLIC (mounted BEFORE localAuth — acp-api server.js L90-98; empty/bogus Bearer
  // → 400 body-validation, never 401), so it is NOT the gate. The real 401 at "start
  // running" was the renderer's post-OAuth Bearer-gated data loads (projects/team/
  // kanban/mail, mounted AFTER localAuth — server.js L172) sending no Bearer → "no backend".
  // getLocalSecret() is the same live source lifecycle-hub/lifecycle-server/the
  // renderer-IPC already use. Fall back to process.env ONLY for run-from-source,
  // where acp-api is started separately with a shared ACP_LOCAL_SECRET.
  const secret = getLocalSecret() || process.env.ACP_LOCAL_SECRET || '';
  if (secret) {
    headers['Authorization'] = `Bearer ${secret}`;
  }
  
  const response = await fetch(url, {
    ...options,
    headers,
  });
  
  return response.json();
}

/**
 * Login through ACP API
 */
export async function acpApiLogin(
  email: string,
  password: string
): Promise<LoginResponse> {
  try {
    const data = await acpApiCall('/v1/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    });
    
    if (!data.success) {
      return {
        success: false,
        error: data.error || {
          code: 'LOGIN_FAILED',
          message: 'Login failed',
        },
      };
    }
    
    return {
      success: true,
      result: {
        user_id: data.data.user_id,
        email: data.data.email,
        expires_in: data.data.expires_in,
      },
    };
  } catch (err: any) {
    return {
      success: false,
      error: {
        code: 'NETWORK_ERROR',
        message: err.message,
      },
    };
  }
}

/**
 * Logout through ACP API
 */
export async function acpApiLogout(): Promise<void> {
  try {
    await acpApiCall('/v1/auth/logout', {
      method: 'POST',
    });
  } catch {
    // Best effort
  }
}

/**
 * Refresh token through ACP API
 */
export async function acpApiRefresh(): Promise<{ success: boolean; error?: string }> {
  try {
    const data = await acpApiCall('/v1/auth/refresh', {
      method: 'POST',
    });
    if (!data.success) {
      return { success: false, error: data.error?.message || `Refresh failed (${data.error?.code || 'UNKNOWN'})` };
    }
    return { success: true };
  } catch (err: any) {
    return { success: false, error: err.message || 'Network error during refresh' };
  }
}

/**
 * Get auth status from ACP API
 */
export async function acpApiGetStatus(): Promise<StatusResponse> {
  try {
    const data = await acpApiCall('/v1/auth/status');
    return data;
  } catch (err: any) {
    return {
      success: false,
    };
  }
}

/**
 * Persist a session in acp-api built from externally-acquired IDP tokens
 * (renderer OAuth flow). acp-api stores it in the same tokenManager session
 * password login uses, so mail proxy / refresh / status all work uniformly.
 */
export async function acpApiSetExternalSession(payload: {
  accessToken: string;
  refreshToken?: string;
  user: { userId: string; email: string; fullName?: string; roles?: string[] };
}): Promise<{ success: boolean; error?: AcpApiError }> {
  try {
    const data = await acpApiCall('/v1/auth/external-session', {
      method: 'POST',
      body: JSON.stringify({
        access_token: payload.accessToken,
        refresh_token: payload.refreshToken,
        user: {
          user_id: payload.user.userId,
          email: payload.user.email,
          full_name: payload.user.fullName,
          roles: payload.user.roles,
        },
      }),
    });

    if (!data.success) {
      return {
        success: false,
        error: data.error || { code: 'EXTERNAL_SESSION_FAILED', message: 'External session set failed' },
      };
    }

    return { success: true };
  } catch (err: any) {
    return {
      success: false,
      error: { code: 'NETWORK_ERROR', message: err.message },
    };
  }
}

/**
 * Get access token from ACP API (for other API calls)
 */
export async function acpApiGetToken(): Promise<string | null> {
  try {
    const data = await acpApiCall('/v1/auth/token');
    if (data.success) {
      return data.data.access_token;
    }
    return null;
  } catch {
    return null;
  }
}

interface AgentProfileResponse {
  success?: boolean;
  data?: {
    name?: string;
    displayName?: string;
    role?: string;
    profile?: string;
  };
}

/**
 * Fetch an agent's profile from the ACP API.
 * Uses X-ACP-Agent header for agent identity; profile is returned as markdown.
 */
export async function acpApiGetAgentProfile(agentName: string): Promise<string | null> {
  try {
    const data = await acpApiCall(`/v1/agents/${encodeURIComponent(agentName)}/profile`, {
      headers: { 'X-ACP-Agent': agentName },
    });
    const payload = (data as AgentProfileResponse)?.data ?? (data as { profile?: string });
    return typeof payload.profile === 'string' ? payload.profile : null;
  } catch (err: any) {
    console.warn(`[ACP-API] profile fetch failed for ${agentName}:`, err.message);
    return null;
  }
}

interface MailInboxResponse {
  success?: boolean;
  data?: {
    messages?: unknown[];
    unread?: number;
  };
}

/**
 * Fetch an agent's unread mail count from the ACP API.
 */
export async function acpApiGetUnreadMailCount(agentName: string): Promise<number | null> {
  try {
    const data = await acpApiCall(
      `/v1/mail/inbox/${encodeURIComponent(agentName)}?unread=true`,
      {
        headers: { 'X-ACP-Agent': agentName },
      },
    );
    const payload = (data as MailInboxResponse)?.data ?? (data as { messages?: unknown[]; unread?: number });
    if (typeof payload.unread === 'number') return payload.unread;
    if (Array.isArray(payload.messages)) return payload.messages.length;
    return 0;
  } catch (err: any) {
    console.warn(`[ACP-API] unread mail fetch failed for ${agentName}:`, err.message);
    return null;
  }
}

/**
 * Fetch an agent's unread mail count from ACP API.
 * Returns the count, or null on failure.
 */
export async function acpApiGetAgentMailUnreadCount(agentName: string): Promise<number | null> {
  try {
    const data = await acpApiCall(`/v1/mail/inbox/${encodeURIComponent(agentName)}?unread=true`, {
      headers: { 'X-ACP-Agent': agentName },
    });
    const messages = data?.data?.messages;
    if (Array.isArray(messages)) return messages.length;
    return null;
  } catch (err: any) {
    console.warn(`[ACP-API] Failed to fetch mail for ${agentName}:`, err.message);
    return null;
  }
}

/**
 * Register a PTY terminal spawned directly by the main process with the local
 * acp-api sidecar. Seeds the sidecar's BackoffManager lifecycle state so that
 * the sidecar can track agent health and resolve project_id/session_id for any
 * internal routes that still need lifecycle context. Without this,
 * spawn-orchestrator agents bypass the lifecycle system.
 */
export async function registerPtyTerminal(payload: RegisterPtyTerminalPayload): Promise<void> {
  try {
    const data = await acpApiCall('/internal/pty/register', {
      method: 'POST',
      body: JSON.stringify({
        agentName: payload.agentName,
        terminalId: payload.terminalId,
        projectId: payload.projectId,
        provider: payload.provider,
      }),
    });
    if (!data?.success) {
      throw new Error(data?.error?.message || 'Local sidecar returned non-success');
    }
  } catch (err: any) {
    console.warn(`[ACP-API] PTY terminal registration failed for ${payload.agentName}:`, err.message);
    throw err;
  }
}

