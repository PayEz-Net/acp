// Agent configuration
export interface AgentConfig {
  id: string;
  name: string;
  displayName: string;
  workDir: string;
  autoStart: boolean;
  position: 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';
  color?: string;
}

// Agent runtime state
export interface AgentState extends AgentConfig {
  status: 'offline' | 'starting' | 'ready' | 'busy' | 'idle' | 'error';
  terminalId?: string;
  lastOutput?: string;
}

// Terminal data from PTY
export interface TerminalData {
  terminalId: string;
  data: string;
}

// App layout modes
export type LayoutMode = 'grid' | 'focus-left' | 'focus-right' | 'tabs';

// App settings persisted to disk
export interface AppSettings {
  layout: LayoutMode;
  focusAgent: string;
  agents: AgentConfig[];
  mailPollInterval: number;
  theme: 'light' | 'dark' | 'system';
  windowBounds: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  sidebarWidth: number;
  showSidebar: boolean;
}

// IPC channel names
export const IPC_CHANNELS = {
  // PTY management
  PTY_SPAWN: 'pty:spawn',
  PTY_WRITE: 'pty:write',
  PTY_RESIZE: 'pty:resize',
  PTY_KILL: 'pty:kill',
  PTY_DATA: 'pty:data',
  PTY_EXIT: 'pty:exit',

  // Settings
  SETTINGS_GET: 'settings:get',
  SETTINGS_SET: 'settings:set',

  // Window
  WINDOW_MINIMIZE: 'window:minimize',
  WINDOW_MAXIMIZE: 'window:maximize',
  WINDOW_CLOSE: 'window:close',
} as const;

// Default settings
export const DEFAULT_SETTINGS: AppSettings = {
  layout: 'grid',
  focusAgent: 'BAPert',
  agents: [
    { id: '1', name: 'BAPert', displayName: 'BAPert', workDir: 'E:\\Repos', autoStart: true, position: 'top-right', color: '#7c3aed' },
    { id: '2', name: 'DotNetPert', displayName: 'DotNetPert', workDir: 'E:\\Repos', autoStart: true, position: 'bottom-left', color: '#06b6d4' },
    { id: '3', name: 'NextPert', displayName: 'NextPert', workDir: 'E:\\Repos', autoStart: true, position: 'top-left', color: '#10b981' },
    { id: '4', name: 'QAPert', displayName: 'QAPert', workDir: 'E:\\Repos', autoStart: true, position: 'bottom-right', color: '#f59e0b' },
  ],
  mailPollInterval: 10000,
  theme: 'dark',
  windowBounds: { x: 100, y: 100, width: 1600, height: 900 },
  sidebarWidth: 280,
  showSidebar: true,
};
