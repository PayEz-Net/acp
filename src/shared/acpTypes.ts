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
}

export interface AcpAvailableCommand {
  name: string;
  description: string;
}

export type AcpSessionUpdate =
  | { sessionUpdate: 'initialized'; sessionId: string; capabilities: AcpAgentCapabilities; agentInfo: AcpAgentInfo }
  | { sessionUpdate: 'available_commands_update'; sessionId: string; availableCommands?: AcpAvailableCommand[] }
  | { sessionUpdate: 'agent_thought_chunk'; sessionId: string; content: AcpContentBlock }
  | { sessionUpdate: 'agent_message_chunk'; sessionId: string; content: AcpContentBlock }
  | { sessionUpdate: 'tool_call'; sessionId: string; toolCall: AcpToolCall }
  | { sessionUpdate: 'tool_call_update'; sessionId: string; toolCall: AcpToolCall }
  | { sessionUpdate: 'permission_request'; sessionId: string; requestId: number | string; options: AcpPermissionOption[]; toolCall: AcpToolCall }
  | { sessionUpdate: 'turn_complete'; sessionId: string; stopReason: string }
  | { sessionUpdate: 'error'; sessionId?: string; error: string }
  | { sessionUpdate: 'stderr'; sessionId?: string; text: string };

export interface AcpEventPayload {
  agent: string;
  sessionId: string;
  update: AcpSessionUpdate;
}

export interface AcpPromptPayload {
  agent: string;
  sessionId: string;
  text: string;
}

export interface AcpCancelPayload {
  agent: string;
  sessionId: string;
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
  pendingPermission?: {
    requestId: number | string;
    options: AcpPermissionOption[];
    toolCall: AcpToolCall;
  };
  error?: string;
}
