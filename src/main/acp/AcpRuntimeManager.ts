import { EventEmitter } from 'events';
import {
  type AcpAgentCapabilities,
  type AcpAgentInfo,
  type AcpContentBlock,
  type AcpEventPayload,
  type AcpPermissionOption,
  type AcpSessionUpdate,
  type AcpToolCall,
} from '../../shared/acpTypes';
import type { TerminalProvider } from '../../shared/types';
import { AcpProcess, type AcpJsonRpcMessage } from './AcpProcess';
import { getProviderConfig, type ProviderConfig } from './providerConfigs';

// Robust ANSI/control-character/TUI cleanup. The Kimi CLI can leak SGR/cursor
// fragments, backspace sequences, and stray carriage returns into content blocks
// (especially tool stdout). Stripping/normalizing them here keeps the renderer
// from painting trash characters, mid-word fractures, or truncated lines.
const ANSI_OR_CONTROL =
  /\u001b\[[\d;]*[A-Za-z]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b\[[\d;]*$|\u001b$|[\x00-\x07\x0B-\x0C\x0E-\x1F\x7F]/g;

function stripAnsiAndControls(text: string): string {
  return text.replace(ANSI_OR_CONTROL, '');
}

function applyBackspaces(text: string): string {
  // Process terminal-style backspace characters so "ab\b\bc" becomes "c".
  const chars: string[] = [];
  for (const ch of text) {
    if (ch === '\b') {
      chars.pop();
    } else {
      chars.push(ch);
    }
  }
  return chars.join('');
}

function normalizeLineEndings(text: string): string {
  // Convert CRLF to LF and drop lone CRs so rendered blocks don't double-space
  // or contain carriage-return artifacts.
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '');
}

function sanitizeContentText(text: string): string {
  // Order matters: process backspaces on the raw text first so they remove the
  // characters the terminal would have erased, then strip any remaining ANSI /
  // control characters and normalize line endings.
  return normalizeLineEndings(stripAnsiAndControls(applyBackspaces(text)));
}

export interface AcpRuntimeOptions {
  agentName: string;
  workDir: string;
  projectId?: number;
  bootPrompt?: string;
  effort?: string;
}

interface PendingPermission {
  requestId: number | string;
  resolve: (optionId: string) => void;
}

export class AcpRuntimeManager extends EventEmitter {
  private process: AcpProcess | null = null;
  private sessionId: string | null = null;
  private initialized = false;
  private pendingPermissions = new Map<number | string, PendingPermission>();
  private autoApprove = false;

  constructor(
    private readonly id: string,
    private readonly provider: ProviderConfig,
    private readonly options: AcpRuntimeOptions,
  ) {
    super();
  }

  getId(): string {
    return this.id;
  }

  getAgentName(): string {
    return this.options.agentName;
  }

  getProjectId(): number | undefined {
    return this.options.projectId;
  }

  getProvider(): TerminalProvider {
    return this.provider.id;
  }

  getSessionId(): string | null {
    return this.sessionId;
  }

  isInitialized(): boolean {
    return this.initialized;
  }

  setAutoApprove(enabled: boolean): void {
    this.autoApprove = enabled;
  }

  async start(): Promise<void> {
    if (this.process) return;

    const [command, ...args] = this.provider.acpCommand;
    this.process = new AcpProcess({
      command,
      args,
      cwd: this.options.workDir,
      // Force a non-interactive, colorless stdio environment. NO_COLOR /
      // FORCE_COLOR strip ANSI escapes; TERM=dumb + CI=true prevent the CLI
      // from attempting a TUI redraw on a pipe.
      env: { NO_COLOR: '1', FORCE_COLOR: '0', TERM: 'dumb', CI: 'true' },
    });

    this.process.on('notification', (method: string, params: unknown, id?: number | string) => {
      this.handleNotification(method, params, id);
    });

    this.process.on('stderr', (text: string) => {
      this.emitAcpEvent({ sessionUpdate: 'stderr', sessionId: this.sessionId ?? undefined, text });
    });

    this.process.on('error', (err: Error) => {
      this.emitAcpEvent({ sessionUpdate: 'error', sessionId: this.sessionId ?? undefined, error: err.message });
    });

    this.process.on('exit', (code: number | null, signal: string | null) => {
      this.emitAcpEvent({
        sessionUpdate: 'error',
        sessionId: this.sessionId ?? undefined,
        error: `ACP process exited (code=${code}, signal=${signal})`,
      });
    });

    this.process.start();

    try {
      const initResult = (await this.process.request('initialize', {
        protocolVersion: 1,
        capabilities: this.provider.defaultCapabilities,
        clientInfo: { name: 'acp-desktop', version: '1.0.0' },
      })) as Record<string, unknown>;

      const sessionResult = (await this.process.request('session/new', {
        mcpServers: [],
        cwd: this.options.workDir,
      })) as Record<string, unknown>;

      this.sessionId = (sessionResult.sessionId as string) ?? null;
      this.initialized = true;

      this.emitAcpEvent({
        sessionUpdate: 'initialized',
        sessionId: this.sessionId ?? '',
        capabilities: (initResult.agentCapabilities as AcpAgentCapabilities) ?? {},
        agentInfo: (initResult.agentInfo as AcpAgentInfo) ?? { name: this.provider.displayName },
      });

      this.process.notify('session/list_commands', { sessionId: this.sessionId });
    } catch (err) {
      this.emitAcpEvent({
        sessionUpdate: 'error',
        sessionId: this.sessionId ?? undefined,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }

  async prompt(text: string): Promise<void> {
    if (!this.process || !this.sessionId) {
      throw new Error('ACP runtime not initialized');
    }

    // Send prompt without awaiting — the response arrives as streaming notifications.
    this.process
      .request('session/prompt', {
        sessionId: this.sessionId,
        prompt: [{ type: 'text', text }],
      })
      .catch((err) => {
        this.emitAcpEvent({ sessionUpdate: 'error', sessionId: this.sessionId ?? undefined, error: err.message });
      });
  }

  cancel(): void {
    if (!this.process || !this.sessionId) return;
    this.process.notify('session/cancel', { sessionId: this.sessionId });
  }

  setMode(mode: string): void {
    if (!this.process || !this.sessionId) return;
    this.process.notify('session/set_mode', { sessionId: this.sessionId, modeId: mode });
  }

  kill(): void {
    if (!this.process) return;
    this.process.kill('SIGTERM');
    this.process = null;
    this.sessionId = null;
    this.initialized = false;
  }

  respondToPermission(requestId: number | string, optionId: string, outcome = 'selected'): void {
    const pending = this.pendingPermissions.get(requestId);
    if (pending) {
      pending.resolve(optionId);
      this.pendingPermissions.delete(requestId);
      return;
    }
    // If no pending renderer approval, send directly.
    this.sendPermissionResponse(requestId, optionId, outcome);
  }

  private handleNotification(method: string, params: unknown, id?: number | string): void {
    if (method === 'session/request_permission') {
      this.handlePermissionRequest({ jsonrpc: '2.0', id, method, params });
      return;
    }

    if (method !== 'session/update' || !params || typeof params !== 'object') return;
    const updateParams = params as Record<string, unknown>;
    const update = updateParams.update as Record<string, unknown> | undefined;
    if (!update) return;

    const sessionUpdate = update.sessionUpdate as string;
    const sessionId = (updateParams.sessionId as string) ?? this.sessionId ?? '';

    switch (sessionUpdate) {
      case 'available_commands_update': {
        const availableCommands = (update.availableCommands as Array<{ name: string; description: string }>) ?? [];
        this.emitAcpEvent({ sessionUpdate: 'available_commands_update', sessionId, availableCommands });
        break;
      }
      case 'agent_thought_chunk': {
        const content = extractContent(update.content);
        if (content) this.emitAcpEvent({ sessionUpdate: 'agent_thought_chunk', sessionId, content });
        break;
      }
      case 'agent_message_chunk': {
        const content = extractContent(update.content);
        if (content) this.emitAcpEvent({ sessionUpdate: 'agent_message_chunk', sessionId, content });
        break;
      }
      case 'tool_call': {
        const toolCall = parseToolCall(update);
        if (toolCall) this.emitAcpEvent({ sessionUpdate: 'tool_call', sessionId, toolCall });
        break;
      }
      case 'tool_call_update': {
        const toolCall = parseToolCall(update);
        if (toolCall) this.emitAcpEvent({ sessionUpdate: 'tool_call_update', sessionId, toolCall });
        break;
      }
      case 'turn_complete': {
        const stopReason = (update.stopReason as string) ?? 'unknown';
        this.emitAcpEvent({ sessionUpdate: 'turn_complete', sessionId, stopReason });
        break;
      }
      default:
        // Ignore unknown update types safely.
        break;
    }
  }

  private handlePermissionRequest(message: AcpJsonRpcMessage): void {
    const params = (message.params ?? {}) as Record<string, unknown>;
    const options = (params.options as AcpPermissionOption[]) ?? [];
    const toolCall = parseToolCall(params.toolCall as Record<string, unknown>) ?? {
      toolCallId: 'unknown',
      title: 'Permission request',
      status: 'in_progress',
      content: [],
    };
    const requestId = message.id ?? 'unknown';

    if (this.autoApprove) {
      const allowAlways = options.find((o) => o.kind === 'allow_always');
      const allowOnce = options.find((o) => o.kind === 'allow_once');
      const optionId = allowAlways?.optionId ?? allowOnce?.optionId ?? options[0]?.optionId ?? 'reject';
      this.sendPermissionResponse(requestId, optionId);
      return;
    }

    // Defer to renderer for explicit approval.
    this.pendingPermissions.set(requestId, {
      requestId,
      resolve: (optionId) => this.sendPermissionResponse(requestId, optionId),
    });

    this.emitAcpEvent({
      sessionUpdate: 'permission_request',
      sessionId: this.sessionId ?? '',
      requestId,
      options,
      toolCall,
    });
  }

  private sendPermissionResponse(
    requestId: number | string,
    optionId: string,
    outcome = 'selected',
  ): void {
    if (!this.process) return;
    // Live kimi acp requires a JSON-RPC *response* (matching the request id)
    // with result.outcome as an object, not a flat result or method call.
    this.process.respond(requestId, {
      outcome: {
        outcome,
        optionId,
      },
    });
  }

  private emitAcpEvent(update: AcpSessionUpdate): void {
    const payload: AcpEventPayload = {
      agent: this.options.agentName,
      sessionId: this.sessionId ?? '',
      update,
    };
    this.emit('event', payload);
  }
}

function extractContent(content: unknown): AcpContentBlock | null {
  if (!content) return null;

  // Already nested ACP content block.
  if (
    typeof content === 'object' &&
    (content as Record<string, unknown>).type === 'content' &&
    (content as Record<string, unknown>).content
  ) {
    const inner = (content as Record<string, unknown>).content as Record<string, unknown>;
    if (inner.type === 'text') {
      return { type: 'content', content: { type: 'text', text: sanitizeContentText(String(inner.text ?? '')) } };
    }
    if (inner.type === 'image') {
      return {
        type: 'content',
        content: {
          type: 'image',
          data: String(inner.data ?? ''),
          mimeType: String(inner.mimeType ?? inner.media_type ?? 'image/png'),
        },
      };
    }
    return null;
  }

  // Plain string fallback (legacy or simplified transport).
  if (typeof content === 'string') {
    return { type: 'content', content: { type: 'text', text: sanitizeContentText(content) } };
  }

  // Flat text object fallback.
  if (typeof content === 'object' && (content as Record<string, unknown>).text !== undefined) {
    return {
      type: 'content',
      content: { type: 'text', text: sanitizeContentText(String((content as Record<string, unknown>).text)) },
    };
  }

  return null;
}

function parseToolCall(update: Record<string, unknown>): AcpToolCall | null {
  const toolCallId = (update.toolCallId as string) ?? '';
  const title = (update.title as string) ?? 'Tool';
  const status = (update.status as AcpToolCall['status']) ?? 'in_progress';
  const rawContent = update.content;

  const content: AcpContentBlock[] = [];
  if (Array.isArray(rawContent)) {
    for (const item of rawContent) {
      const coerced = extractContent(item);
      if (coerced) content.push(coerced);
    }
  }

  if (!toolCallId) return null;
  return { toolCallId, title, status, content };
}
