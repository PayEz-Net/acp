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
  vibeApiUrl: string;
  environment: 'prod' | 'dev';
  // Vibe API client identity (display/routing — HMAC creds now live in acp-api)
  vibeClientId?: string;
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

  // Vibe credentials (Client ID + HMAC key — fallback mode only)
  VIBE_GET_CREDENTIALS: 'vibe:getCredentials',

  // ACP backend (local acp-api)
  ACP_GET_BACKEND_STATUS: 'acp:getBackendStatus',
  ACP_GET_LOCAL_SECRET: 'acp:getLocalSecret',
  ACP_RETRY_BACKEND: 'acp:retryBackend',
  ACP_GET_LOGS: 'acp:getLogs',
  ACP_BACKEND_STATUS_CHANGED: 'acp:backendStatusChanged',
} as const;

// Vibe credentials type
export interface VibeCredentials {
  clientId: string;
  hmacKey: string;
}

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
  vibeApiUrl: 'https://api.idealvibe.online',
  environment: 'prod',
  vibeClientId: 'vibe_b2d2aac0315549d9',
};

// ============================================
// ACP (Agent Collaboration Platform) Types
// ============================================

// Character names for the 5 agents
export type ACPCharacter = 'sage' | 'forge' | 'pixel' | 'nova' | 'raven';

// Agent states in the party room
export type ACPAgentStatus = 'idle' | 'working' | 'moving' | 'mingling' | 'blocked' | 'celebrating' | 'paused';

// Zones in the party room
export type ACPZone = 'entrance' | 'bar' | 'table-db' | 'table-ui' | 'table-api' | 'table-qa' | 'lounge';

// Position in the party room (percentage-based for responsive layout)
export interface ACPPosition {
  x: number; // 0-100 percentage
  y: number; // 0-100 percentage
}

// Character visual configuration
export interface ACPCharacterConfig {
  character: ACPCharacter;
  agentName: string; // Maps to BAPert, DotNetPert, etc.
  displayName: string; // Sage, Forge, etc.
  title: string; // "the Architect", "the Builder", etc.
  color: string; // Primary color
  colorSecondary: string; // Secondary color
  traits: string[]; // e.g., ["Methodical", "Strategic"]
  quote: string; // Character quote
  stats: {
    speed: number; // 0-100
    creativity: number;
    precision: number;
    intel: number;
  };
}

// ACP Agent runtime state
export interface ACPAgent {
  id: string;
  character: ACPCharacter;
  agentName: string;
  position: ACPPosition;
  targetPosition?: ACPPosition; // For movement animation
  zone: ACPZone;
  status: ACPAgentStatus;
  currentTask?: string;
  taskProgress?: number; // 0-100
  minglingWith?: string; // Agent ID if mingling
  selected: boolean;
  lastActivity?: string;
}

// Event types for the event log
export type ACPEventType =
  | 'agent_entered'
  | 'agent_moved'
  | 'agent_working'
  | 'agent_blocked'
  | 'agent_completed'
  | 'mingle_started'
  | 'mingle_ended'
  | 'human_message'
  | 'system';

// Event log entry
export interface ACPEvent {
  id: string;
  type: ACPEventType;
  timestamp: Date;
  agentId?: string;
  agentName?: string;
  targetAgentId?: string;
  targetAgentName?: string;
  message: string;
  details?: string;
}

// Chat message in agent panel
export interface ACPChatMessage {
  id: string;
  agentId: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: Date;
  streaming?: boolean;
}

// Zone configuration for positioning
export interface ACPZoneConfig {
  id: ACPZone;
  label: string;
  bounds: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
}

// Default character configurations
export const ACP_CHARACTERS: Record<ACPCharacter, ACPCharacterConfig> = {
  sage: {
    character: 'sage',
    agentName: 'BAPert',
    displayName: 'Sage',
    title: 'the Architect',
    color: '#D4A017', // Gold
    colorSecondary: '#F5E6C3',
    traits: ['Strategic', 'Methodical'],
    quote: 'The architecture is the soul of the product. Every decision echoes forward.',
    stats: { speed: 65, creativity: 85, precision: 90, intel: 95 },
  },
  forge: {
    character: 'forge',
    agentName: 'DotNetPert',
    displayName: 'Forge',
    title: 'the Builder',
    color: '#58A6FF', // Steel Blue
    colorSecondary: '#A5D6FF',
    traits: ['Reliable', 'Precise'],
    quote: 'Solid foundations make everything possible. Build it right the first time.',
    stats: { speed: 70, creativity: 60, precision: 95, intel: 85 },
  },
  pixel: {
    character: 'pixel',
    agentName: 'NextPert',
    displayName: 'Pixel',
    title: 'the Creative',
    color: '#3FB950', // Emerald
    colorSecondary: '#A7F3D0',
    traits: ['Creative', 'Detail-oriented'],
    quote: 'The user experience is the heart of the product. Every pixel counts toward trust.',
    stats: { speed: 78, creativity: 94, precision: 62, intel: 88 },
  },
  nova: {
    character: 'nova',
    agentName: 'NextPertTwo',
    displayName: 'Nova',
    title: 'the Swift',
    color: '#56D364', // Light Green
    colorSecondary: '#ECFDF5',
    traits: ['Fast', 'Energetic'],
    quote: 'Ship it. Learn. Iterate. Speed is a feature.',
    stats: { speed: 95, creativity: 75, precision: 70, intel: 80 },
  },
  raven: {
    character: 'raven',
    agentName: 'QAPert',
    displayName: 'Raven',
    title: 'the Watcher',
    color: '#A371F7', // Purple
    colorSecondary: '#DDD6FE',
    traits: ['Thorough', 'Skeptical'],
    quote: 'Trust, but verify. The details are where quality lives.',
    stats: { speed: 60, creativity: 70, precision: 98, intel: 92 },
  },
};

// ============================================
// Cocktail Party Algorithm Types
// ============================================

// Agent broadcast signal (what they're working on, needs, offers)
export interface AgentSignal {
  agentId: string;
  agentName: string;
  partyName: string; // Display name (Sage, Forge, etc.)
  location: ACPZone;
  workingOn: string;
  keywords: string[];
  needs: string[];
  offers: string[];
  timestamp: Date;
}

// Pairwise relevance score between two agents
export interface RelevanceScore {
  agentA: string;
  agentB: string;
  score: number;
  breakdown: {
    needsOffersMatch: number; // A needs what B offers
    offersNeedsMatch: number; // B needs what A offers
    keywordOverlap: number;   // Shared keywords
  };
}

// Interaction types at the party
export type InteractionType = 'gossip' | 'chit_chat' | 'deep_talk';

// Mingle session between two agents
export interface MingleSession {
  id: string;
  agents: [string, string];
  type: InteractionType;
  startTime: Date;
  endTime?: Date;
  outcome?: 'useful' | 'not_useful' | 'pending';
  topic?: string;
}

// Agent's memory of another agent (for relevance scoring)
export interface AgentRelevanceMemory {
  observerAgent: string;
  subjectAgent: string;
  domainTags: string[];
  typicalOffers: string[];
  typicalNeeds: string[];
  recentKeywords: string[];
  lastBroadcastTs: Date;
  totalMingles: number;
  successfulMingles: number;
  lastMingleTs?: Date;
  lastMingleOutcome?: 'useful' | 'not_useful' | 'pending';
  baseRelevance: number;
  recentRelevance: number;
  interactionScore: number;
  combinedScore: number;
}

// Party state for the simulation
export interface PartyState {
  signals: Map<string, AgentSignal>;
  relevanceMatrix: Map<string, RelevanceScore>;
  activeMingles: MingleSession[];
  isPaused: boolean;
  lastUpdate: Date;
}

// Thresholds for the algorithm
export const PARTY_THRESHOLDS = {
  MINGLE: 60,           // Score needed to trigger mingle
  APPROACH: 40,         // Score needed to start drifting toward
  CHIT_CHAT: 40,        // Min score for quick exchange
  DEEP_TALK: 70,        // Min score for lounge conversation
  NEEDS_OFFERS: 50,     // Points for A needs what B offers
  OFFERS_NEEDS: 40,     // Points for B needs what A offers
  KEYWORD_MATCH: 10,    // Points per keyword overlap
};

// Default zone configurations
export const ACP_ZONES: ACPZoneConfig[] = [
  { id: 'table-db', label: 'DB Architecture', bounds: { x: 5, y: 8, width: 20, height: 15 } },
  { id: 'table-ui', label: 'UI Components', bounds: { x: 28, y: 8, width: 20, height: 15 } },
  { id: 'table-api', label: 'API Routes', bounds: { x: 51, y: 8, width: 20, height: 15 } },
  { id: 'table-qa', label: 'QA Testing', bounds: { x: 74, y: 8, width: 20, height: 15 } },
  { id: 'bar', label: 'Bar Zone', bounds: { x: 2, y: 35, width: 12, height: 35 } },
  { id: 'lounge', label: 'Lounge', bounds: { x: 60, y: 60, width: 35, height: 30 } },
  { id: 'entrance', label: 'Entrance', bounds: { x: 35, y: 88, width: 30, height: 10 } },
];

// ============================================
// Action Panel Protocol Types
// ============================================

/**
 * A single action that can be taken from an ActionPanel.
 * Actions are pre-filled with params so agents don't need to remember syntax.
 */
export interface PanelAction {
  /** The action verb/command to execute */
  action: string;

  /** Pre-filled parameters for this action */
  params?: Record<string, unknown>;

  /** Human-readable hint explaining why you'd do this */
  hint: string;

  /** Optional keyboard shortcut (e.g., "1", "c", "Enter") */
  key?: string;

  /** If true, requires confirmation before executing */
  destructive?: boolean;

  /** If true, action is currently unavailable */
  disabled?: boolean;

  /** Explanation for why action is disabled */
  disabledReason?: string;

  /** Optional icon name (lucide-react icon) */
  icon?: string;
}

/**
 * An ActionPanel wraps MCP tool responses with available actions.
 * Every MCP response should be an ActionPanel so agents know what to do next.
 */
export interface ActionPanel<T = unknown> {
  /** The data that was requested */
  data: T;

  /** Available actions on this data */
  actions: PanelAction[];

  /** Suggested next action (best action for common case) */
  suggested?: string;

  /** Additional context for decision-making */
  context?: Record<string, unknown>;

  /** Optional title for the panel */
  title?: string;

  /** Optional status message */
  status?: 'success' | 'error' | 'warning' | 'info';

  /** Optional status message text */
  statusMessage?: string;
}

// Common ActionPanel data types for type safety

/** Mail inbox data from check_mail */
export interface MailInboxData {
  unread: number;
  total: number;
  messages: Array<{
    id: number;
    from: string;
    subject: string;
    priority?: 'high' | 'normal' | 'low';
    preview?: string;
    timestamp?: string;
  }>;
}

/** Single message data from read_mail */
export interface MailMessageData {
  id: number;
  from: string;
  to: string;
  subject: string;
  body: string;
  timestamp: string;
  attachments?: Array<{
    name: string;
    path: string;
  }>;
}

/** Kanban task data from get_task */
export interface KanbanTaskData {
  id: number;
  title: string;
  description?: string;
  status: KanbanLane;
  assignedTo?: string;
  priority: KanbanPriority;
  labels?: string[];
  dueDate?: string;
}

/** File data from read_file */
export interface FileData {
  path: string;
  content: string;
  lines: number;
  language?: string;
  recentlyModified?: boolean;
  uncommittedChanges?: boolean;
}

// ============================================
// Agent Mail Push Notification Types (SignalR)
// ============================================

/** Push notification event types from Agent Mail hub */
export type MailPushEventType = 'new_message' | 'agent_response' | 'mention' | 'high_importance';

/** Payload for mail push notifications via SignalR */
export interface MailPushNotification {
  event_type: MailPushEventType;
  timestamp: string;
  notification_id: string;
  data: {
    message_id: number;
    thread_id?: string;
    inbox_id: number;
    from_agent: string;
    from_agent_display: string;
    to_agent: string;
    subject?: string;
    preview?: string;
    importance: 'low' | 'normal' | 'high' | 'urgent';
    created_at: string;
  };
  metadata: {
    client_id: number;
    user_id?: number;
  };
}

/** SignalR hub subscription status */
export interface MailPushConnectionStatus {
  connection_id?: string;
  user_id?: number;
  connected_at?: string;
  subscribed_agents: string[];
  state: 'connecting' | 'connected' | 'reconnecting' | 'disconnected';
}

/** IPC channels for push notifications (main ↔ renderer) */
export const PUSH_CHANNELS = {
  // Main → Renderer
  PUSH_NOTIFICATION: 'push:notification',
  PUSH_CONNECTION_STATUS: 'push:connectionStatus',
  
  // Renderer → Main  
  PUSH_CONNECT: 'push:connect',
  PUSH_DISCONNECT: 'push:disconnect',
  PUSH_SUBSCRIBE: 'push:subscribe',
  PUSH_UNSUBSCRIBE: 'push:unsubscribe',
} as const;
