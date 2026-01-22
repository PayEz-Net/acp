// API Client for Electron MVP
// Ported from PayEz React Native MVP

import { ApiResponse } from '@shared/auth';

// Configuration - localhost for dev, prod URL for release
// @ts-expect-error Vite provides import.meta.env
const IDP_URL = import.meta.env?.DEV
  ? 'http://localhost:32785'
  : 'https://idp.payez.net';

const CLIENT_ID = 'payez-electron';

interface RequestOptions extends RequestInit {
  token?: string;
  skipAuth?: boolean;
  skipInterceptor?: boolean;
}

// Token callbacks - set by auth store
let tokenRefreshCallback: (() => Promise<string | null>) | null = null;
let getTokenCallback: (() => string | null) | null = null;

export function configureApiAuth(config: {
  getToken: () => string | null;
  refreshToken: () => Promise<string | null>;
}) {
  getTokenCallback = config.getToken;
  tokenRefreshCallback = config.refreshToken;
}

// Get current token (for use by other stores)
export function getAuthToken(): string | null {
  return getTokenCallback ? getTokenCallback() : null;
}

class StandardizedApi {
  private baseUrl: string;
  private defaultHeaders: HeadersInit;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl;
    this.defaultHeaders = {
      'Content-Type': 'application/json',
      'X-Client-Id': CLIENT_ID,
      'X-Platform': 'electron',
    };
  }

  private async request<T>(
    endpoint: string,
    options: RequestOptions = {},
    isRetry = false
  ): Promise<ApiResponse<T>> {
    const { token, skipAuth, skipInterceptor, headers = {}, ...fetchOptions } = options;

    const finalHeaders: HeadersInit = {
      ...this.defaultHeaders,
      ...headers,
    };

    const authToken = token || (!skipAuth && getTokenCallback ? getTokenCallback() : null);
    if (authToken && !skipAuth) {
      (finalHeaders as Record<string, string>)['Authorization'] = `Bearer ${authToken}`;
    }

    try {
      const response = await fetch(`${this.baseUrl}${endpoint}`, {
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

      // Handle 401 - attempt token refresh and retry
      if (response.status === 401 && !isRetry && !skipInterceptor && tokenRefreshCallback) {
        console.log('[API] 401 received, attempting token refresh...');
        try {
          const newToken = await tokenRefreshCallback();
          if (newToken) {
            console.log('[API] Token refreshed, retrying request...');
            return this.request<T>(endpoint, { ...options, token: newToken }, true);
          }
        } catch (refreshError) {
          console.error('[API] Token refresh failed:', refreshError);
        }
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

// IDP API instance
const idpApi = new StandardizedApi(IDP_URL);

// Account API methods
export const accountApi = {
  login: (email: string, password: string) =>
    idpApi.post('/api/ExternalAuth/login', { username_or_email: email, password, client_id: CLIENT_ID }, { skipAuth: true }),

  refreshToken: (refreshToken: string) =>
    idpApi.post('/api/ExternalAuth/refresh', { refresh_token: refreshToken }, { skipAuth: true }),

  revokeToken: (token: string) =>
    idpApi.post('/api/ExternalAuth/revoke', {}, { token }),

  sendTwoFactorCode: (method: 'sms' | 'email', token: string) =>
    idpApi.post(`/api/ExternalAuth/twofa/${method}/send`, {}, { token }),

  verifyTwoFactor: (code: string, method: 'sms' | 'email', token: string) =>
    idpApi.post(`/api/ExternalAuth/twofa/${method}/verify`, { code }, { token }),

  getMaskedInfo: (token: string) =>
    idpApi.post('/api/Account/masked-info', {}, { token }),
};
