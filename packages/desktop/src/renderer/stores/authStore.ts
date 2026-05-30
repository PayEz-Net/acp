/**
 * Auth Store for Renderer
 *
 * Simple store that communicates with main process via IPC.
 * All IDP calls and token storage happen in main process.
 * Renderer only sees auth status, never raw tokens.
 */

import { create } from 'zustand';
import { AuthStatus, AuthUser, LoginResult, TwoFactorResult } from '@shared/types';
import { buildOAuthUrl, completeOAuthFlow } from '../services/oauth';

// Auth flow states
export enum AuthFlowState {
  UNAUTHENTICATED = 'unauthenticated',
  AUTHENTICATING = 'authenticating',
  REQUIRES_2FA = 'requires_2fa',
  VERIFYING_2FA = 'verifying_2fa',
  AUTHENTICATED = 'authenticated',
  ERROR = 'error',
}

interface AuthStore {
  // State
  authFlowState: AuthFlowState;
  isLoading: boolean;
  user: AuthUser | null;
  error: string | null;
  requires2FA: boolean;
  twoFactorComplete: boolean;
  available2FAMethods: string[];

  // Actions
  login: (email: string, password: string) => Promise<void>;
  loginWithOAuth: (provider: string) => Promise<void>;
  logout: () => Promise<void>;
  send2FACode: (method: 'email' | 'sms') => Promise<void>;
  verify2FA: (code: string, method: 'email' | 'sms') => Promise<void>;
  loadStatus: () => Promise<void>;
  refreshToken: () => Promise<void>;
}

export const useAuthStore = create<AuthStore>((set, _get) => ({
  // Initial state
  authFlowState: AuthFlowState.UNAUTHENTICATED,
  isLoading: true,
  user: null,
  error: null,
  requires2FA: false,
  twoFactorComplete: false,
  available2FAMethods: ['email'],

  /**
   * Login with email/password
   */
  login: async (email: string, password: string) => {
    set({ isLoading: true, error: null, authFlowState: AuthFlowState.AUTHENTICATING });

    try {
      // Check if electronAPI is available
      if (!window.electronAPI?.authLogin) {
        throw new Error('Not running in Electron');
      }

      const result: LoginResult = await window.electronAPI.authLogin({ email, password });

      if (!result.success) {
        throw new Error(result.error || 'Login failed');
      }

      // Get updated status from main process
      const status = await window.electronAPI.authGetStatus();

      if (result.requires2FA && !status.twoFactorComplete) {
        set({
          isLoading: false,
          user: status.user,
          requires2FA: true,
          twoFactorComplete: false,
          available2FAMethods: result.available2FAMethods || ['email'],
          authFlowState: AuthFlowState.REQUIRES_2FA,
        });
      } else {
        set({
          isLoading: false,
          user: status.user,
          requires2FA: status.requires2FA,
          twoFactorComplete: status.twoFactorComplete,
          authFlowState: AuthFlowState.AUTHENTICATED,
        });
      }

      console.log('[AuthStore] Login successful');
    } catch (error) {
      console.error('[AuthStore] Login error:', error);
      set({
        error: error instanceof Error ? error.message : 'Login failed',
        isLoading: false,
        authFlowState: AuthFlowState.ERROR,
      });
      throw error;
    }
  },

  /**
   * Login via OAuth (Google / GitHub / Microsoft / etc.)
   *
   * Opens the IDP authorize URL in the system browser, waits for the
   * oauth-server.ts callback to forward code+state via IPC, completes the
   * IDP token exchange + registration via oauth.ts, then pushes the
   * resulting tokens into acp-api via authSetExternalSession so the
   * server-side session is unified with the password-login path. After
   * that, mail proxy / refresh / status all work the same regardless of
   * how the user signed in.
   */
  loginWithOAuth: async (provider: string) => {
    set({ isLoading: true, error: null, authFlowState: AuthFlowState.AUTHENTICATING });

    try {
      if (!window.electronAPI?.openOAuthUrl || !window.electronAPI.onOAuthCallback) {
        throw new Error('Not running in Electron');
      }

      const authorizeUrl = await buildOAuthUrl(provider);

      // Wire the one-shot callback listener BEFORE opening the URL so a
      // fast callback isn't missed, but DO NOT await yet — we need to
      // open the browser first, then await the resolution.
      const callbackPromise = new Promise<{ success: boolean; code?: string; state?: string; error?: { code: string; message: string } }>((resolve) => {
        const unsubscribe = window.electronAPI.onOAuthCallback((data) => {
          unsubscribe();
          resolve(data);
        });
      });

      await window.electronAPI.openOAuthUrl(authorizeUrl);

      const data = await callbackPromise;

      if (!data.success || !data.code || !data.state) {
        throw new Error(data.error?.message || 'OAuth callback failed');
      }

      const result = await completeOAuthFlow(data.code, data.state);

      if (!result.success || !result.user || !result.accessToken) {
        throw new Error(result.error?.message || 'OAuth completion failed');
      }

      // Persist the IDP session in acp-api so server-side consumers
      // (mail proxy, refresh, status) see a unified session.
      const sessionResult = await window.electronAPI.authSetExternalSession({
        accessToken: result.accessToken,
        refreshToken: result.refreshToken,
        user: result.user,
      });

      if (!sessionResult.success) {
        // C1 (NO SWALLOW): a failed external-session means the sidecar has
        // NO usable session — the login is NOT actually complete
        // (project/team/mail will 401). Surface the real error and
        // loud-fail (4ac087e-style) instead of flipping to AUTHENTICATED.
        // The throw is caught below -> ERROR state + rethrow. No ||/??/
        // default; the real error is surfaced verbatim.
        console.error('[AuthStore] External session persistence FAILED — login NOT complete:', sessionResult.error);
        throw new Error('External session persistence failed: ' + JSON.stringify(sessionResult.error));
      }

      set({
        isLoading: false,
        user: {
          id: result.user.userId,
          email: result.user.email,
          name: result.user.fullName,
          roles: result.user.roles,
        },
        requires2FA: false,
        twoFactorComplete: true,
        authFlowState: AuthFlowState.AUTHENTICATED,
      });

      console.log('[AuthStore] OAuth login successful via', provider);
    } catch (error) {
      console.error('[AuthStore] OAuth login error:', error);
      set({
        error: error instanceof Error ? error.message : 'OAuth login failed',
        isLoading: false,
        authFlowState: AuthFlowState.ERROR,
      });
      throw error;
    }
  },

  /**
   * Logout
   */
  logout: async () => {
    try {
      if (window.electronAPI?.authLogout) {
        await window.electronAPI.authLogout();
      }
    } catch (e) {
      console.warn('[AuthStore] Logout error:', e);
    }

    set({
      user: null,
      error: null,
      isLoading: false,
      requires2FA: false,
      twoFactorComplete: false,
      authFlowState: AuthFlowState.UNAUTHENTICATED,
    });

    console.log('[AuthStore] Logged out');
  },

  /**
   * Send 2FA code
   */
  send2FACode: async (method: 'email' | 'sms') => {
    if (!window.electronAPI?.authSend2FA) {
      throw new Error('Not running in Electron');
    }

    const result = await window.electronAPI.authSend2FA(method);

    if (!result.success) {
      throw new Error(result.error || 'Failed to send code');
    }

    console.log('[AuthStore] 2FA code sent via', method);
  },

  /**
   * Verify 2FA code
   */
  verify2FA: async (code: string, method: 'email' | 'sms') => {
    set({ isLoading: true, authFlowState: AuthFlowState.VERIFYING_2FA });

    try {
      if (!window.electronAPI?.authVerify2FA) {
        throw new Error('Not running in Electron');
      }

      const result: TwoFactorResult = await window.electronAPI.authVerify2FA({ code, method });

      if (!result.success) {
        throw new Error(result.error || 'Invalid code');
      }

      // Get updated status
      const status = await window.electronAPI.authGetStatus();

      set({
        isLoading: false,
        user: status.user,
        twoFactorComplete: true,
        authFlowState: AuthFlowState.AUTHENTICATED,
      });

      console.log('[AuthStore] 2FA verified');
    } catch (error) {
      console.error('[AuthStore] 2FA error:', error);
      set({
        error: error instanceof Error ? error.message : '2FA failed',
        isLoading: false,
        authFlowState: AuthFlowState.REQUIRES_2FA,
      });
      throw error;
    }
  },

  /**
   * Load auth status on app start
   */
  loadStatus: async () => {
    set({ isLoading: true });

    try {
      if (!window.electronAPI?.authGetStatus) {
        // Not in Electron - use dev/browser mode with mock auth
        console.log('[AuthStore] Browser mode - auto-authenticating for development');
        set({
          isLoading: false,
          authFlowState: AuthFlowState.AUTHENTICATED,
          user: {
            id: 'dev-user',
            email: 'dev@localhost',
            name: 'Developer',
            roles: ['admin'],
          },
        });
        return;
      }

      const status: AuthStatus = await window.electronAPI.authGetStatus();

      if (!status.user) {
        set({ isLoading: false, authFlowState: AuthFlowState.UNAUTHENTICATED });
        return;
      }

      // Determine auth state
      let authFlowState: AuthFlowState;
      if (status.isAuthenticated) {
        authFlowState = AuthFlowState.AUTHENTICATED;
      } else if (status.requires2FA && !status.twoFactorComplete) {
        authFlowState = AuthFlowState.REQUIRES_2FA;
      } else {
        authFlowState = AuthFlowState.UNAUTHENTICATED;
      }

      set({
        isLoading: false,
        user: status.user,
        requires2FA: status.requires2FA,
        twoFactorComplete: status.twoFactorComplete,
        authFlowState,
      });

      console.log('[AuthStore] Status loaded:', authFlowState);
    } catch (error) {
      console.error('[AuthStore] Load status error:', error);
      set({ isLoading: false, authFlowState: AuthFlowState.UNAUTHENTICATED });
    }
  },

  /**
   * Refresh token
   */
  refreshToken: async () => {
    try {
      if (!window.electronAPI?.authRefresh) {
        return;
      }

      const result = await window.electronAPI.authRefresh();

      if (!result.success) {
        console.warn('[AuthStore] Token refresh failed:', result.error);
        // Do NOT logout here. Token refresh is the API's job (single-authority
        // consolidation per BAPert WO). The main-process background timer keeps
        // trying; only after max consecutive failures does main broadcast a
        // session-dead signal. Renderer-initiated logout on a transient blip
        // was the root cause of the "it shut down and made me log in again"
        // loop (c812789 follow-up).
      } else {
        console.log('[AuthStore] Token refreshed');
      }
    } catch (error) {
      console.error('[AuthStore] Refresh error:', error);
    }
  },
}));

// Computed helpers
export const useIsAuthenticated = () => {
  const { authFlowState } = useAuthStore();
  return authFlowState === AuthFlowState.AUTHENTICATED;
};

export const useRequires2FA = () => {
  const { authFlowState } = useAuthStore();
  return authFlowState === AuthFlowState.REQUIRES_2FA || authFlowState === AuthFlowState.VERIFYING_2FA;
};
