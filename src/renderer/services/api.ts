// API Client for Electron MVP
// Ported from PayEz React Native MVP

import { ApiResponse } from '@shared/auth';
import { IDP_CLIENT_APP, IDP_CLIENT_APP_HEADER } from '@shared/idp-config';
import { getIdpUrl } from './endpoints';

// No IDP_URL literal here (WO #292) — the base URL comes from the main-process
// env authority via the cloud:endpoints IPC, resolved lazily per request.
const CLIENT_ID = 'idealvibe_online';

interface RequestOptions extends RequestInit {
  token?: string;
  skipAuth?: boolean;
  skipInterceptor?: boolean;
}

// Get current token (for use by other stores)
export function getAuthToken(): string | null {
  return null;
}

class StandardizedApi {
  private resolveBaseUrl: () => Promise<string>;
  private defaultHeaders: HeadersInit;

  constructor(resolveBaseUrl: () => Promise<string>) {
    this.resolveBaseUrl = resolveBaseUrl;
    this.defaultHeaders = {
      'Content-Type': 'application/json',
      'X-Client-Id': CLIENT_ID,
      [IDP_CLIENT_APP_HEADER]: IDP_CLIENT_APP,
      'X-Platform': 'electron',
    };
  }

  private async request<T>(
    endpoint: string,
    options: RequestOptions = {}
  ): Promise<ApiResponse<T>> {
    const { token, skipAuth, skipInterceptor, headers = {}, ...fetchOptions } = options;

    const finalHeaders: HeadersInit = {
      ...this.defaultHeaders,
      ...headers,
    };

    const authToken = token || null;
    if (authToken && !skipAuth) {
      (finalHeaders as Record<string, string>)['Authorization'] = `Bearer ${authToken}`;
    }

    try {
      // Resolve the base URL from the main-process env authority (cold-start
      // safe: awaits the IPC, never a host-less call). WO #292.
      const baseUrl = await this.resolveBaseUrl();
      const response = await fetch(`${baseUrl}${endpoint}`, {
        ...fetchOptions,
        headers: finalHeaders,
      });

      const contentType = response.headers.get('content-type');
      const isJson = contentType?.includes('application/json');

      let data: unknown;
      if (isJson) {
        data = await response.json();
      } else {
        data = await response.text();
      }

      if (!response.ok) {
        const errData = data as { code?: string; message?: string; error?: string };
        return {
          success: false,
          error: {
            code: errData?.code || `HTTP_${response.status}`,
            message: errData?.message || errData?.error || response.statusText,
          },
        };
      }

      return { success: true, data: data as T };
    } catch (error) {
      console.error('API request failed:', error);
      return {
        success: false,
        error: {
          code: 'NETWORK_ERROR',
          message: error instanceof Error ? error.message : 'Network request failed',
        },
      };
    }
  }

  async get<T>(endpoint: string, options?: RequestOptions): Promise<ApiResponse<T>> {
    return this.request<T>(endpoint, { ...options, method: 'GET' });
  }

  async post<T>(endpoint: string, body?: unknown, options?: RequestOptions): Promise<ApiResponse<T>> {
    return this.request<T>(endpoint, {
      ...options,
      method: 'POST',
      body: body ? JSON.stringify(body) : undefined,
    });
  }
}

// IDP API instance — base URL resolved lazily from the env authority (IPC).
const idpApi = new StandardizedApi(getIdpUrl);

// Account API methods
export const accountApi = {
  login: (email: string, password: string) =>
    idpApi.post('/api/ExternalAuth/login', { username_or_email: email, password, client_id: CLIENT_ID, app: IDP_CLIENT_APP }, { skipAuth: true }),

  revokeToken: (token: string) =>
    idpApi.post('/api/ExternalAuth/revoke', {}, { token }),

  sendTwoFactorCode: (method: 'sms' | 'email', token: string) =>
    idpApi.post(`/api/ExternalAuth/twofa/${method}/send`, {}, { token }),

  verifyTwoFactor: (code: string, method: 'sms' | 'email', token: string) =>
    idpApi.post(`/api/ExternalAuth/twofa/${method}/verify`, { code }, { token }),

  getMaskedInfo: (token: string) =>
    idpApi.post('/api/Account/masked-info', {}, { token }),
};
