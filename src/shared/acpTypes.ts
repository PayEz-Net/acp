/**
 * Canonical renderer-side ACP (Agent Client Protocol) contract.
 *
 * The main process forwards JSON-RPC session/update notifications with this
 * envelope on the ACP_EVENT IPC channel:
 *
 *   { agent: string; sessionId: string; update: AcpSessionUpdate }
 *
 * Main performs only lightweight shape coercion so TypeScript can consume the
 * updates directly; no semantic normalization layer lives here.
 */

export interface AcpTextContent {
  type: 'text';
  text: string;
}

export interface AcpImageContent {
  type: 'image';
  data: string;
  mimeType: string;
}

export interface AcpNestedContentBlock {
  type: 'content';
  content: AcpTextContent | AcpImageContent;
}

export type AcpContentBlock = AcpNestedContentBlock;

/** Flat content blocks used for outgoing ACP prompts (session/prompt). */
export type AcpSendContentBlock = AcpTextContent | AcpImageContent;

export type AcpToolCallStatus = 'in_progress' | 'completed' | 'failed';

export interface AcpToolCall {
  toolCallId: string;
  title: string;
  status: AcpToolCallStatus;
  content: AcpContentBlock[];
  contentText?: string;
}

export interface AcpPermissionOption {
  optionId: string;
  name: string;
  kind: 'allow_once' | 'allow_always' | 'reject_once';
}

export interface AcpPlanItem {
  id: string;
  title: string;
  status: 'pending' | 'in_progress' | 'done' | 'failed';
}

export interface AcpPlan {
  items: AcpPlanItem[];
}

export interface AcpAgentCapabilities {
  loadSession?: boolean;
  mcpCapabilities?: { http?: boolean; sse?: boolean };
  promptCapabilities?: { audio?: boolean; embeddedContext?: boolean; image?: boolean };
  sessionCapabilities?: { list?: Record<string, unknown>; resume?: Record<string, unknown> };
}

export interface AcpAgentInfo {
  name: string;
  version?: string;
  /** Active model id from the runtime's init (claude stream-json system/init.model). */
  model?: string;
  /**
   * Per-agent effort level the manager spawned this agent with. Claude only —
   * kimi/codex ignore effort, so the manager leaves it unset for them.
   */
  effort?: string;
}

export interface AcpAvailableCommand {
  name: string;
  description: string;
}

/**
 * What the runtime is currently waiting on, forwarded from the adapter's
 * custom `wait_state` session update (kimi-code acp-adapter). `kind` is a
 * plain string so newer runtimes can add kinds without breaking older
 * clients; known values today:
 *
 *  - `'awaiting_first_token'`: a step's LLM request is in flight but no
 *    assistant output has streamed yet (provider latency).
 *  - `'provider_retry'`: a provider request failed retryably and the
 *    runtime is backing off before the next attempt; the attempt/delay
 *    fields are only present for this kind.
 */
export interface AcpWaitState {
  kind: string;
  failedAttempt?: number;
  nextAttempt?: number;
  maxAttempts?: number;
  delayMs?: number;
  errorName?: string;
  statusCode?: number;
}

export type AcpSessionUpdate =
  | { sessionUpdate: 'initialized'; sessionId: string; capabilities: AcpAgentCapabilities; agentInfo: AcpAgentInfo; imageIn?: boolean }
  | { sessionUpdate: 'available_commands_update'; sessionId: string; availableCommands?: AcpAvailableCommand[] }
  | { sessionUpdate: 'agent_thought_chunk'; sessionId: string; content: AcpContentBlock }
  | { sessionUpdate: 'agent_message_chunk'; sessionId: string; content: AcpContentBlock }
  | { sessionUpdate: 'tool_call'; sessionId: string; toolCall: AcpToolCall }
  | { sessionUpdate: 'tool_call_update'; sessionId: string; toolCall: AcpToolCall }
  | { sessionUpdate: 'permission_request'; sessionId: string; requestId: number | string; options: AcpPermissionOption[]; toolCall: AcpToolCall }
  | { sessionUpdate: 'wait_state'; sessionId: string; waitState: AcpWaitState }
  | { sessionUpdate: 'prompt_queued'; sessionId: string; queueDepth: number }
  | { sessionUpdate: 'prompt_dequeued'; sessionId: string; queueDepth: number }
  | { sessionUpdate: 'queue_cleared'; sessionId: string }
  | { sessionUpdate: 'turn_complete'; sessionId: string; stopReason: string }
  | { sessionUpdate: 'error'; sessionId?: string; error: string }
  | { sessionUpdate: 'stderr'; sessionId?: string; text: string }
  | { sessionUpdate: 'spawn_info'; sessionId?: string; command: string };

export interface AcpEventPayload {
  agent: string;
  sessionId: string;
  update: AcpSessionUpdate;
}

/**
 * Outgoing image attachment for an ACP prompt. `data` is base64 WITHOUT the
 * data-URL prefix, matching the adapter's `{ type: 'image', data, mimeType }`
 * content-block contract.
 */
export interface AcpPromptImage {
  data: string;
  mimeType: string;
  name?: string;
}

export interface AcpPromptPayload {
  agent: string;
  sessionId: string;
  text: string;
  images?: AcpPromptImage[];
}

export interface AcpInjectMailPayload {
  agent: string;
  sessionId: string;
  text: string;
}

/**
 * Tri-state result of a mail notice inject (WO 11622 follow-up, Jon
 * 2026-08-01): 'delivered' — the runtime accepted the notice; 'deferred' —
 * the agent is mid-turn and the push was deliberately skipped (mail parks
 * in the inbox, NOT a failure); 'failed' — the notice genuinely could not
 * be delivered (runtime down/unknown agent). The renderer must be able to
 * tell defer from failure: a boolean false collapsed both and printed
 * "Delivery failed" for routine mid-turn defers.
 */
export type AcpMailInjectResult = 'delivered' | 'deferred' | 'failed';

export interface AcpCancelPayload {
  agent: string;
  sessionId: string;
}

/** Purge the queued prompt backlog after a human interrupt (WO 11572). */
export interface AcpPurgeQueuePayload {
  agent: string;
}

export interface AcpSetModePayload {
  agent: string;
  sessionId: string;
  mode: string;
}

export interface AcpKillPayload {
  agent: string;
  sessionId: string;
}

export interface AcpPermissionResponsePayload {
  agent: string;
  sessionId: string;
  permissionRequestId: number | string;
  outcome: string;
  optionId?: string;
}

export type AcpTurnStatus =
  | 'idle'
  | 'thinking'
  | 'tool'
  | 'answering'
  | 'done'
  | 'error';

export interface AcpTurn {
  id: string;
  agent: string;
  sessionId: string;
  turnId?: string;
  role: 'user' | 'assistant';
  status: AcpTurnStatus;
  content: AcpContentBlock[];
  contentText: string;
  thinking: string;
  toolCalls: AcpToolCall[];
  plan?: AcpPlan;
  stopReason?: string;
  ts: string;
}

export interface AcpSessionState {
  sessionId?: string;
  runtimeMode?: 'acp' | 'pty';
  capabilities?: AcpAgentCapabilities;
  agentInfo?: AcpAgentInfo;
  availableCommands?: AcpAvailableCommand[];
  turns: AcpTurn[];
  activeTurnId: string | null;
  /**
   * Current runtime wait-state (provider latency / retry backoff), set by
   * `wait_state` updates and cleared by the next content-bearing update or
   * turn end. Absent on older runtimes that never emit wait-state frames.
   */
  waitState?: AcpWaitState;
  /**
   * Whether the active model accepts image input, from the `model` arm of the
   * runtime's session configOptions (kimi-code fork delta). `undefined` means
   * unknown (older runtime that does not advertise it) — the composer allows
   * image sends and lets the server gate decide; only an explicit `false`
   * refuses locally.
   */
  imageIn?: boolean;
  /**
   * Exact command the runtime was launched with (e.g. `kimi --yolo -m
   * kimi-code/kimi-for-coding-highspeed acp` + any KIMI_MODEL_THINKING_EFFORT
   * env), emitted by main at every spawn. Rendered as a muted banner line at
   * the top of the ACP pane — the old PTY shell echo's replacement, kept OUT
   * of the transcript turns (QA: no system lines in the transcript).
   */
  spawnCommand?: string;
  pendingPermission?: {
    requestId: number | string;
    options: AcpPermissionOption[];
    toolCall: AcpToolCall;
  };
  error?: string;
}
