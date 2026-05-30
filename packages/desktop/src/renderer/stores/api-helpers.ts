import { IDP_CLIENT_APP, IDP_CLIENT_APP_HEADER } from '@shared/idp-config';
import { useProjectStore } from './projectStore';

let localSecretCache: string | null = null;

export async function getCachedLocalSecret(): Promise<string | null> {
  if (localSecretCache) return localSecretCache;
  if (window.electronAPI?.getLocalSecret) {
    try {
      localSecretCache = await window.electronAPI.getLocalSecret();
      return localSecretCache;
    } catch (err) {
      console.error('[API] Failed to get local secret:', err);
    }
  }
  return null;
}

export function clearSecretCache(): void {
  localSecretCache = null;
}

export function getActiveProjectId(): number | undefined {
  try {
    return useProjectStore.getState().activeProject?.id;
  } catch {
    return undefined;
  }
}

/**
 * Build an acp-api URL with automatic ?project_id= when an active project is set.
 * Handles endpoints that already contain query parameters.
 */
export function buildUrl(basePath: string, endpoint: string): string {
  const projectId = getActiveProjectId();
  const hasQuery = endpoint.includes('?');
  const sep = hasQuery ? '&' : '?';
  const projectQs = projectId !== undefined
    ? `${sep}project_id=${encodeURIComponent(String(projectId))}`
    : '';
  return `http://127.0.0.1:3001${basePath}${endpoint}${projectQs}`;
}

export interface ApiRequestOptions {
  method?: string;
  body?: unknown;
  agentName?: string;
}

/**
 * Authenticated fetch to the local acp-api sidecar.
 * Automatically appends ?project_id= when a project is active.
 */
export async function apiRequest(basePath: string, endpoint: string, options: ApiRequestOptions = {}): Promise<Response> {
  const { method = 'GET', body, agentName } = options;
  const secret = await getCachedLocalSecret();
  const url = buildUrl(basePath, endpoint);

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    [IDP_CLIENT_APP_HEADER]: IDP_CLIENT_APP,
  };
  if (secret) {
    headers['Authorization'] = `Bearer ${secret}`;
  }
  if (agentName) {
    headers['X-ACP-Agent'] = agentName;
  }

  return fetch(url, {
    method,
    headers,
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}
