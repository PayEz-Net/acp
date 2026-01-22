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

// Kanban lane (status) - matches Vibe SQL schema
export type KanbanLane = 'backlog' | 'ready' | 'in_progress' | 'review' | 'done';

// Kanban task priority - matches Vibe SQL schema
export type KanbanPriority = 'low' | 'normal' | 'high' | 'urgent';

// Kanban board from Vibe SQL (agent_kanban_boards)
export interface KanbanBoard {
  id: number;
  team_id?: number;
  name: string;
  lanes_json?: string[];
  created_at: string;
}

// Kanban task from Vibe SQL (agent_kanban_tasks)
export interface KanbanTask {
  id: number;
  board_id: number;
  title: string;
  description?: string;
  lane: KanbanLane;
  assigned_agent_id?: number;
  created_by_agent_id?: number;
  priority: KanbanPriority;
  labels?: string[];
  due_date?: string;
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

// Autonomy stop conditions
export type StopCondition = 'milestone' | 'blocker' | 'time';

// Autonomy status from backend
export interface AutonomyStatus {
  enabled: boolean;
  specId?: number;
  specTitle?: string;
  milestone?: string;
  stopCondition: StopCondition;
  maxRuntimeHours: number;
  notifyPhone?: string;
  skipPermissions?: boolean;
  startedAt?: string;
  elapsedMinutes?: number;
}

// Standup entry event types
export type StandupEventType =
  | 'completed'
  | 'blocked'
  | 'started'
  | 'review_requested'
  | 'review_passed'
  | 'review_failed'
  | 'milestone_done';

// Standup entry from backend
export interface StandupEntry {
  id: number;
  agent: string;
  event_type: StandupEventType;
  summary: string;
  task_id?: number;
  created_at: string;
}

// Standup filter options
export interface StandupFilters {
  agents: string[];
  eventTypes: StandupEventType[];
  since: 'today' | '24h' | '7d' | 'custom';
  customSince?: string;
}

// Document types
export type DocumentType = 'spec' | 'report' | 'review' | 'plan' | 'other';

// Agent document from Vibe SQL
export interface AgentDocument {
  id: number;
  title: string;
  content_md: string;
  type: DocumentType;
  author_agent?: string;
  version: number;
  parent_document_id?: number;
  created_at: string;
  updated_at?: string;
}

// Document version history
export interface DocumentVersion {
  id: number;
  document_id: number;
  version: number;
  content_md: string;
  author_agent?: string;
  created_at: string;
  change_summary?: string;
}

// Notification types
export type NotificationType = 'mail' | 'task' | 'review' | 'mention' | 'system';

export interface Notification {
  id: number;
  type: NotificationType;
  title: string;
  message: string;
  agent?: string;
  link?: string;
  read: boolean;
  created_at: string;
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
  mailPushEnabled: boolean;
  mailPushUrl: string;
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

  // Auth (main process handles IDP calls + token storage)
  AUTH_LOGIN: 'auth:login',
  AUTH_LOGOUT: 'auth:logout',
  AUTH_REFRESH: 'auth:refresh',
  AUTH_GET_STATUS: 'auth:getStatus',
  AUTH_SEND_2FA: 'auth:send2fa',
  AUTH_VERIFY_2FA: 'auth:verify2fa',

  // OAuth
  OAUTH_OPEN_URL: 'oauth:openUrl',
  OAUTH_CALLBACK: 'oauth:callback',

  // Window
  WINDOW_MINIMIZE: 'window:minimize',
  WINDOW_MAXIMIZE: 'window:maximize',
  WINDOW_CLOSE: 'window:close',
} as const;

// Auth types for IPC
export interface AuthUser {
  id: string;
  email: string;
  name: string;
  roles: string[];
}

export interface AuthStatus {
  isAuthenticated: boolean;
  user: AuthUser | null;
  requires2FA: boolean;
  twoFactorComplete: boolean;
  expiresAt: string | null;
}

export interface LoginRequest {
  email: string;
  password: string;
}

export interface LoginResult {
  success: boolean;
  error?: string;
  requires2FA?: boolean;
  available2FAMethods?: string[];
}

export interface TwoFactorRequest {
  code: string;
  method: 'email' | 'sms';
}

export interface TwoFactorResult {
  success: boolean;
  error?: string;
}

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
  mailPushEnabled: true,
  mailPushUrl: 'https://api.idealvibe.online',
};
