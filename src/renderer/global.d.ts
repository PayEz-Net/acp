import { AppSettings, TerminalData, AuthStatus, LoginRequest, LoginResult, TwoFactorRequest, TwoFactorResult, SpawnFailedPayload } from '@shared/types';

export {};

declare global {
  interface Window {
    electronAPI: {
      // PTY management. spawnAgent IPC removed (SPEC-team-runtime §3.3 FLAG 6) —
      // the phantom !backendAvailable spawn fallback that guessed the runtime.
      writeTerminal: (terminalId: string, data: string) => void;
      resizeTerminal: (terminalId: string, cols: number, rows: number) => void;
      killTerminal: (terminalId: string) => void;
      // List live terminals with the provider each was launched with
      // (SPEC-team-runtime §3.2). Backs reconcile-on-switch.
      listTerminals: () => Promise<Array<{ id: string; agentName: string; projectId?: number; provider: 'claude' | 'kimi' | 'codex' }>>;
      onTerminalData: (callback: (data: TerminalData) => void) => () => void;
      onAgentSpawned: (callback: (data: { agentName: string; terminalId: string }) => void) => () => void;
      onTerminalExit: (callback: (data: { terminalId: string; exitCode: number }) => void) => () => void;
      // Main → renderer: a spawn failed with a typed cause (WORKDIR_INVALID).
      // The orchestrator path has no renderer fetch to catch the throw, so this
      // carries it to the shared WorkdirCorrection surface (SPEC-workdir §3.4).
      onPtySpawnFailed: (callback: (payload: SpawnFailedPayload) => void) => () => void;

      // Settings
      getSettings: () => Promise<AppSettings>;
      getCloudEndpoints: () => Promise<{ vibeApiUrl: string; hubUrl: string; idpUrl: string; envName: string; isPackaged: boolean; isInternalDevBuild: boolean }>;
      reseedLifecycle: () => Promise<void>;
      // Pre-flight working-dir validation (SPEC-workdir-invalid §3.5).
      validateWorkDir: (path: string) => Promise<{ ok: boolean; resolved: string | null }>;
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
      authSetExternalSession: (payload: {
        accessToken: string;
        refreshToken?: string;
        user: { userId: string; email: string; fullName?: string; roles?: string[] };
      }) => Promise<{ success: boolean; error?: string }>;
      authGetAccessToken: () => Promise<string | null>;
      onAuthSessionDead: (callback: (data: { error: string }) => void) => () => void;

      // OAuth
      openOAuthUrl: (url: string) => Promise<void>;
      onOAuthCallback: (callback: (data: { success: boolean; code?: string; state?: string; error?: { code: string; message: string } }) => void) => () => void;
      openExternal: (url: string) => Promise<void>;
      readClipboardText: () => Promise<string>;

      // ACP backend
      getBackendStatus: () => Promise<{ available: boolean }>;
      getLocalSecret: () => Promise<string | null>;
      retryBackend: () => Promise<{ available: boolean }>;
      getApiLogs: () => Promise<string[]>;
      getVsqlCacheAuthHeaders: (method: string, path: string) => Promise<Record<string, string | boolean>>;
      onBackendStatusChanged: (callback: (data: { available: boolean; message?: string }) => void) => () => void;
      relaunchApp: () => void;

      // Wave C project-switch + lifecycle event subscribers
      switchProject: (targetProjectId: number, targetProjectName: string) => Promise<{ success: boolean; errorCode?: string; errorMessage?: string }>;
      onProjectSwitchProgress: (callback: (data: { phase: 'cloud-pending' | 'restarting' | 'error'; targetProjectId: number; errorCode?: string; errorMessage?: string }) => void) => () => void;
      onLifecycleProjectChanged: (callback: (data: { oldId: number | null; newId: number | null }) => void) => () => void;
      onLifecycleStateChanged: (callback: (data: { projectId: number; oldState: string | null; newState: string | null }) => void) => () => void;
      onLifecycleCloudUnreachable: (callback: () => void) => () => void;
      onLifecycleCloudRecovered: (callback: () => void) => () => void;

      // Wave C/2 boot overlay (sync IPC)
      getNextBootOverlay: () => { project_id: number; project_name: string } | null;
      clearNextBootOverlay: () => void;
    };
  }
}
