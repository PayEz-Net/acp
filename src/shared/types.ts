// Agent configuration
export interface AgentConfig {
  id: string;
  name: string;
  displayName: string;
  workDir: string;
  autoStart: boolean;
  position: 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';
  color?: string;
  // Per-agent provider override. When set, this agent uses this provider
  // regardless of the global agentProvider setting. Enables mixed-mode
  // teams (e.g. lead on Claude, workers on Kimi).
  provider?: 'claude' | 'kimi' | 'codex';
  // Skill names from acp-skills.json registry (v0.3 fold-in)
  skills?: string[];
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
  // Mail Muffler L2 (BAPert 7133): canonical importance token is lowercase `info` —
  // a NEW value distinct from `low` (intent, not deprioritized). `info` mail is the
  // terminal/no-reply tier; the renderer marks it so the reader releases it on sight.
  // Optional: older messages + non-info tiers may omit it. Flows through the store's
  // `...m` spread; lights up the badge only when the API/SignalR payload carries `info`.
  importance?: 'low' | 'normal' | 'high' | 'urgent' | 'info';
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

// Kanban task priority - matches acp-api VALID_PRIORITIES (low|medium|high|critical)
export type KanbanPriority = 'low' | 'medium' | 'high' | 'critical';

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

// ── Durable Standup Rounds (W1 cloud model — PayEz-Core StandupRoundsController) ──
// The round is the surface unit the board reads in one shot: a snapshot of the
// team at call time (expected_agents) with one report per agent (reports). This
// is DISTINCT from the legacy flat StandupEntry event-log. Wire shape is
// snake_case, project-nested under /v1/projects/{id}/standup/rounds.

export type StandupReportState = 'reported' | 'pending' | 'absent';

// #121 W5 triage lifecycle. "open" needs action; "acknowledged" = seen, no action
// owed; "resolved" = closed. Distinct + never collapsed (Aurum 2619). Ack is an
// EXPLICIT human disposition — never auto on view.
export type BlockerTriageState = 'open' | 'acknowledged' | 'resolved';

// One structured blocker (#121 W5 — the source; blockers_md is derived from these).
export interface StandupBlocker {
  /** Server-assigned, STABLE across rounds — the identity-diff key (M2). */
  blocker_id: string;
  text_md: string;
  /** Optional agent-mail thread for this blocker (open-thread action). Null until linked. */
  thread_id?: string | null;
  triage_state: BlockerTriageState;
}

// One agent's report within a round. did/next/blockers are free-text markdown;
// task_refs are optional kanban id chips. null fields = not yet filed.
export interface StandupReport {
  agent_id: number;
  agent_name: string;
  did_md?: string | null;
  next_md?: string | null;
  blockers_md?: string | null;
  task_refs?: string[] | null;
  reported_at?: string | null;
  updated_at?: string | null;
  state: StandupReportState;
  /** 'skill' | 'mail-harvest' | 'manual'; null while pending. */
  source?: string | null;
  /** #121 W5 — structured blockers (source; blockers_md derived). Null pre-W5/no-blocker. */
  blockers?: StandupBlocker[] | null;
}

export interface StandupExpectedAgent {
  agent_id: number;
  agent_name: string;
}

export interface StandupRound {
  /** Per-project monotonic id, serialized as a STRING on the wire. */
  round_id: string;
  project_id: number;
  started_at: string;
  closed_at?: string | null;
  /** 'manual' | 'scheduled' */
  trigger: string;
  called_by: string;
  status: 'open' | 'closed';
  expected_agents: StandupExpectedAgent[];
  reports: StandupReport[];
  /** Roll-up — null in v1 (D3 later). */
  summary_md?: string | null;
  updated_at?: string | null;
  /**
   * #99 notify-on-open outcome, ALWAYS explicit on the wire:
   * 'sent:2' | 'skipped:no_lead' | 'error:<msg>' | 'unknown'. The source of
   * the W4 done-state filed/skipped rollup — consume verbatim, never re-derive.
   */
  notify_status: string;
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
  // NOTE: the old settings-level `vibeApiUrl` host literal was removed (WO #292) —
  // the cloud vibe-api host is now resolved ONLY by the build-baked env authority
  // (main/env.ts → cloud:endpoints IPC), never a user-setting default.
  environment: 'prod' | 'dev';
  // Vibe API client identity (display/routing — HMAC creds now live in acp-api)
  vibeClientId?: string;
  // AI Agent provider
  agentProvider?: 'claude' | 'kimi' | 'codex';
  // Claude Code effort level: low, medium, high, max
  // Default is 'high' (Aurum 1355): good output without max-burn. 'max' is
  // selectable but is the silent-expensive default we deliberately do NOT ship.
  // Only used when agentProvider is 'claude'
  claudeEffort?: 'low' | 'medium' | 'high' | 'max';
  // Codex model override (default: codex-mini)
  codexModel?: string;
  // Settings schema version — bump when defaults change so existing installs migrate
  settingsVersion?: number;
  // First-run welcome modal — false until user dismisses the tour
  hasSeenWelcome?: boolean;
  // Workspace-colonization consent (spec §2.3/§8 AC7). REAL recorded
  // gate: colonize only runs when true. Installer's hard consent page
  // (M5) records it for end-users; a dev records it knowingly. Absent/
  // false → colonize skips non-destructively. NEVER a silent auto-run.
  colonizationConsent?: boolean;
  // Installer-decided workspace root (installer-spec v2 §5). Recorded by
  // the installer→app handoff on first authenticated launch; consumed as
  // the explicit identity for resolveWorkDir when no project repo_path.
  // Set only by the handoff — no default (absent = installer not run).
  installerWorkspaceRoot?: string;
  // v0.3 skill chips feature flag (default OFF)
  showSkillChips?: boolean;
  // Show thinking blocks in terminal output (default ON)
  showThinking?: boolean;
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
  // Renderer → main (invoke): list live terminals WITH the provider each
  // was launched with (SPEC-team-runtime §3.2). Backs reconcile-on-switch:
  // the renderer compares each running agent's provider to the team runtime
  // to find non-conforming agents to restart.
  PTY_LIST: 'pty:list',
  // Main → renderer: a PTY was spawned for an agent (covers the
  // spawn-orchestrator path the renderer didn't initiate). Renderer maps
  // agentName→terminalId so the pane binds to the live session.
  PTY_SPAWNED: 'pty:spawned',
  // Main → renderer: a spawn FAILED with a typed, actionable cause
  // (currently WORKDIR_INVALID). Covers the spawn-orchestrator path,
  // which has NO renderer fetch to catch the throw — without this the
  // failure is orphaned main-side (SPEC-workdir-invalid §3.4). The
  // renderer dedups by project and renders one actionable surface.
  // Wire value is the literal contract string (fixed event contract,
  // BAPert WO #84034) so any direct listener matches verbatim.
  PTY_SPAWN_FAILED: 'PTY_SPAWN_FAILED',

  // Settings
  SETTINGS_GET: 'settings:get',
  SETTINGS_SET: 'settings:set',

  // Cloud-environment authority (main → renderer). Renderer resolves
  // NOTHING — it asks main, which decided once at build time (env.ts, baked
  // by scripts/gen-env.cjs). Snapshot also carries envName/isPackaged for the
  // read-only env indicator (WO #292).
  CLOUD_ENDPOINTS: 'cloud:endpoints',

  // Renderer → main: re-read current-project + its lifecycle and emit
  // project-lifecycle-changed to the spawn-orchestrator. The explicit
  // user "go" (picker Start) for an already-RUNNING project — no cloud
  // mutation, just hand the orchestrator the state the backend already has.
  LIFECYCLE_RESEED: 'lifecycle:reseed',

  // Auth (main process handles IDP calls + token storage)
  AUTH_LOGIN: 'auth:login',
  AUTH_LOGOUT: 'auth:logout',
  AUTH_REFRESH: 'auth:refresh',
  AUTH_GET_STATUS: 'auth:getStatus',
  AUTH_SEND_2FA: 'auth:send2fa',
  AUTH_VERIFY_2FA: 'auth:verify2fa',
  AUTH_SET_EXTERNAL_SESSION: 'auth:setExternalSession',
  AUTH_SESSION_DEAD: 'auth:sessionDead',

  // OAuth
  OAUTH_OPEN_URL: 'oauth:openUrl',
  OAUTH_CALLBACK: 'oauth:callback',

  // Window
  WINDOW_MINIMIZE: 'window:minimize',
  WINDOW_MAXIMIZE: 'window:maximize',
  WINDOW_CLOSE: 'window:close',

  // ACP backend (local acp-api)
  ACP_GET_BACKEND_STATUS: 'acp:getBackendStatus',
  ACP_GET_LOCAL_SECRET: 'acp:getLocalSecret',
  ACP_RETRY_BACKEND: 'acp:retryBackend',
  ACP_GET_LOGS: 'acp:getLogs',
  ACP_BACKEND_STATUS_CHANGED: 'acp:backendStatusChanged',

  // vsql-cache (PayEz Vibe SQL agent-output store)
  VSQL_CACHE_GET_AUTH_HEADERS: 'vsql-cache:getAuthHeaders',
  // Renderer → main: trigger app.relaunch() + app.exit(0). Originally
  // Ship F-bis fail-loud-stub Restart-ACP affordance. Stays for
  // diagnostic / manual relaunch needs (e.g., backend recovery).
  // Project-switch should NOT use this directly — use PROJECT_SWITCH
  // below which atomically PUTs current-project then relaunches.
  ACP_RELAUNCH: 'acp:relaunch',

  // Wave C project-switch (BAPert msg 1149): renderer → main
  // atomic switch flow. Main process PUTs /v1/projects/current then
  // app.relaunch() + app.exit. New boot's lifecycle-poller +
  // spawn-orchestrator re-instantiate for the new project. Replaces
  // the existing broken in-process switch flow per Jon's flag.
  PROJECT_SWITCH: 'project:switch',
  // Main → renderer: switch flow progress messages (cloud PUT pending /
  // restarting / error). Renderer can surface a 'Switching to X...' UI.
  PROJECT_SWITCH_PROGRESS: 'project:switchProgress',

  // Wave C lifecycle events (main → renderer broadcasts from
  // lifecycle-poller — forwarded via webContents.send). Renderer can
  // subscribe via ipcRenderer.on for live cockpit state visibility.
  LIFECYCLE_PROJECT_CHANGED: 'lifecycle:project-changed',
  LIFECYCLE_STATE_CHANGED: 'lifecycle:state-changed',
  LIFECYCLE_CLOUD_UNREACHABLE: 'lifecycle:cloud-unreachable',
  LIFECYCLE_CLOUD_RECOVERED: 'lifecycle:cloud-recovered',

  // Wave C/2 Commit D/A — next-boot overlay sync read by the pre-mount
  // HTML script. ipcRenderer.sendSync() pattern; main returns the
  // store value synchronously via event.returnValue. Cleared by React
  // on mount-complete to keep the overlay one-shot.
  BOOT_GET_NEXT_OVERLAY: 'boot:getNextOverlay',
  BOOT_CLEAR_NEXT_OVERLAY: 'boot:clearNextOverlay',


  // External links (Privacy, Terms, etc.)
  OPEN_EXTERNAL: 'shell:openExternal',

  // Clipboard read — routed through main because the renderer's
  // navigator.clipboard.readText() is permission-gated (denied in the
  // packaged build, no setPermissionRequestHandler). Main's clipboard
  // module has no such gate. Used by the terminal paste path.
  CLIPBOARD_READ_TEXT: 'clipboard:read-text',

  // Pre-flight working-dir validation (SPEC-workdir-invalid §3.5). Renderer →
  // main: does this `repo_path` resolve to a real directory ON THIS MACHINE?
  // Reuses pty.ts resolveWorkDir (the single workspace-root authority) so the
  // open-time gate and the spawn guard agree byte-for-byte. The project-open
  // flow calls this ONCE before any agent spawn; invalid → refuse to
  // instantiate, spawn nothing, route to the inline correction surface. The
  // inline "Save & open" re-validates the user's typed path through this same
  // channel BEFORE persisting (validate-before-save, never write a 2nd bad path).
  WORKDIR_VALIDATE: 'workdir:validate',
  } as const;

// Payload for IPC_CHANNELS.PTY_SPAWN_FAILED (main → renderer). Fixed event
// contract (BAPert WO #84034) — the renderer surface + integration listener
// build to this EXACTLY. `code` is the typed cause (WORKDIR_INVALID today);
// agent_name/work_dir/message are copied verbatim from WorkDirError's public
// fields. Shared so main, preload, and the renderer surface agree on shape.
export interface SpawnFailedPayload {
  // WORKDIR_INVALID (WO #84034) — project working folder missing on this box.
  // RUNTIME_NOT_SET (WO #84135 §3.3) — active project has no team runtime; the
  //   spawn is BLOCKED rather than defaulted to a silent provider.
  code: 'WORKDIR_INVALID' | 'RUNTIME_NOT_SET';
  agent_name: string;
  /** Present for WORKDIR_INVALID (the bad path). */
  work_dir?: string;
  /** Present for RUNTIME_NOT_SET (the project whose runtime is unset). */
  project_id?: number;
  message: string;
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
// Spec §4.4 — the cloud-down + no-cache fallback team is BAPert + QAPert.
// Backend `team.ts` owns the same seed when its cache misses (Decision 3a);
// these two literals must agree on archetype + position. Drift is a bug.
export const DEFAULT_SETTINGS: AppSettings = {
  layout: 'grid',
  focusAgent: 'BAPert',
  agents: [
    { id: '1', name: 'BAPert', displayName: 'BAPert', workDir: '', autoStart: true, position: 'top-left', color: '#8b5cf6', provider: 'claude' },
    { id: '2', name: 'QAPert', displayName: 'QAPert', workDir: '', autoStart: true, position: 'top-right', color: '#f59e0b', provider: 'claude' },
  ],
  mailPollInterval: 10000,
  theme: 'dark',
  windowBounds: { x: 100, y: 100, width: 1600, height: 900 },
  sidebarWidth: 280,
  showSidebar: true,
  environment: 'prod',
  agentProvider: 'claude', // Default to Claude Code
  claudeEffort: 'high',
  // v3→v4: DEFAULT_AGENTS shrunk from 4 to 2 (BAPert + QAPert);
  // existing installs migrate via store.ts which deletes any
  // cloud-authoritative keys (activeProjectId, vibeClientId-if-leaked)
  // and preserves user UI prefs by archetype name. Reconcile IS the
  // migration for the agent array — orphan archetypes drop on first
  // cloud sync. Per spec §4.4 / §5.1.
  settingsVersion: 6,
  hasSeenWelcome: false,
  colonizationConsent: false,
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
    // L2 (BAPert 7133): include `info` so the push-payload leg agrees with the canonical
    // token end-to-end (DnP enum <-> push payload <-> MailMessage <-> badge). Server ranks
    // `info` below `low` so it does not OS-push (DnP 7134 #4); it rides the in-app NewMessage path.
    importance: 'low' | 'normal' | 'high' | 'urgent' | 'info';
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
