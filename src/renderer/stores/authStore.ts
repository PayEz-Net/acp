/**
 * Auth Store for Renderer
 *
 * Simple store that communicates with main process via IPC.
 * All IDP calls and token storage happen in main process.
 * Renderer only sees auth status, never raw tokens.
 */

import { create } from 'zustand';
import { AuthStatus, AuthUser, LoginResult, TwoFactorResult } from '@shared/types';

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
  logout: () => Promise<void>;
  send2FACode: (method: 'email' | 'sms') => Promise<void>;
  verify2FA: (code: string, method: 'email' | 'sms') => Promise<void>;
  loadStatus: () => Promise<void>;
  refreshToken: () => Promise<void>;
}

export const useAuthStore = create<AuthStore>((set, get) => ({
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
        // Not in Electron - stay unauthenticated
        set({ isLoading: false });
        return;
      }

      const status: AuthStatus = await window.electronAPI.authGetStatus();

      if (!status.user) {
        set({ isLoading: false, authFlowState: AuthFlowState.UNAUTHENTICATED });
        return;
      }

      // Check if token needs refresh
      if (status.expiresAt) {
        const expiresAt = new Date(status.expiresAt);
        const fiveMinutesFromNow = new Date(Date.now() + 5 * 60 * 1000);

        if (expiresAt < fiveMinutesFromNow) {
          await get().refreshToken();
        }
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
        // If refresh fails, logout
        await get().logout();
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
