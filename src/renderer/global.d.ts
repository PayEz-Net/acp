import { AppSettings, TerminalData, AuthStatus, LoginRequest, LoginResult, TwoFactorRequest, TwoFactorResult, VibeCredentials } from '@shared/types';

export {};

declare global {
  interface Window {
    electronAPI: {
      // PTY management
      spawnAgent: (agentName: string, workDir: string) => Promise<string>;
      writeTerminal: (terminalId: string, data: string) => void;
      resizeTerminal: (terminalId: string, cols: number, rows: number) => void;
      killTerminal: (terminalId: string) => void;
      onTerminalData: (callback: (data: TerminalData) => void) => () => void;
      onTerminalExit: (callback: (data: { terminalId: string; code: number }) => void) => () => void;

      // Settings
      getSettings: () => Promise<AppSettings>;
      setSettings: (settings: Partial<AppSettings>) => Promise<void>;

      // Window controls
      minimizeWindow: () => void;
      maximizeWindow: () => void;
      closeWindow: () => void;

      // Auth (main process handles IDP + tokens)
      authLogin: (request: LoginRequest) => Promise<LoginResult>;
      authLogout: () => Promise<{ success: boolean }>;
      authGetStatus: () => Promise<AuthStatus>;
      authRefresh: () => Promise<{ success: boolean; error?: string }>;
      authSend2FA: (method: 'email' | 'sms') => Promise<{ success: boolean; error?: string }>;
      authVerify2FA: (request: TwoFactorRequest) => Promise<TwoFactorResult>;

      // OAuth
      openOAuthUrl: (url: string) => Promise<void>;
      onOAuthCallback: (callback: (data: { success: boolean; code?: string; state?: string; error?: { code: string; message: string } }) => void) => () => void;

      // Vibe credentials (HMAC auth for Agent Mail)
      getVibeCredentials: () => Promise<VibeCredentials>;
    };
  }
}
