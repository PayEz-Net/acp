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

// Mail message from Vibe SQL
export interface MailMessage {
  message_id: number;
  from_agent: string;
  to_agent: string;
  subject: string;
  body: string;
  is_read: boolean;
  created_at: string;
  read_at?: string;
}

// Mail inbox for an agent
export interface AgentMailbox {
  agent: string;
  messages: MailMessage[];
  unreadCount: number;
  loading: boolean;
  error?: string;
}

// Mail API response types
export interface MailListResponse {
  messages: MailMessage[];
  total: number;
}

export interface MailSendRequest {
  from: string;
  to: string;
  subject: string;
  body: string;
}

// Kanban task status
export type KanbanStatus = 'TODO' | 'IN_PROGRESS' | 'DONE';

// Kanban task priority
export type KanbanPriority = 'low' | 'medium' | 'high' | 'urgent';

// Kanban board from Vibe SQL
export interface KanbanBoard {
  board_id: number;
  team_id?: number;
  name: string;
  created_at: string;
}

// Kanban task from Vibe SQL
export interface KanbanTask {
  task_id: number;
  board_id: number;
  title: string;
  description?: string;
  status: KanbanStatus;
  assigned_agent_id?: string;
  assigned_agent_name?: string;
  priority: KanbanPriority;
  created_at: string;
  updated_at?: string;
}

// Kanban store state
export interface KanbanState {
  boards: KanbanBoard[];
  tasks: KanbanTask[];
  selectedBoard: KanbanBoard | null;
  selectedTask: KanbanTask | null;
  loading: boolean;
  error?: string;
}

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
