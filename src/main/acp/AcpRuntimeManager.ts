import { EventEmitter } from 'events';
import { BrowserWindow } from 'electron';
import {
  type AcpAgentCapabilities,
  type AcpAgentInfo,
  type AcpContentBlock,
  type AcpEventPayload,
  type AcpPermissionOption,
  type AcpSendContentBlock,
  type AcpSessionUpdate,
  type AcpToolCall,
} from '../../shared/acpTypes';
import { IPC_CHANNELS, type AgentSessionStartFailedPayload, type TerminalProvider } from '../../shared/types';
import { AcpProcess, type AcpJsonRpcMessage } from './AcpProcess';
import { sanitizeAcpDisplayText } from '../../shared/acpSanitize';
import { getProviderConfig, type ProviderConfig } from './providerConfigs';
import { buildAgentBootPrompt } from './bootPrompt';
import { acpApiGetAgentProfile, acpApiGetUnreadMailCount } from '../acp-api-client';
import { startAgentSession, endAgentSession } from '../agentSessionLifecycle';

export interface AcpRuntimeOptions {
  agentName: string;
  workDir: string;
  projectId?: number;
  bootPrompt?: string;
  effort?: string;
  /** Numeric agent id from the project team table. Used to start a PayEzVibe
   *  agent session while this runtime is alive. */
  agentId?: number;
}

interface PendingPermission {
  requestId: number | string;
  resolve: (optionId: string) => void;
}

// Global serialization lock for ACP provider initialization. Kimi's CLI has
// shared global state (~/.kimi config, lock files, etc.) that races when N
// processes initialize in parallel, producing -32603 internal errors. Running
// initialize/session.new one-at-a-time eliminates that contention.
let initLock = Promise.resolve();

async function acquireInitLock(): Promise<() => void> {
  const oldLock = initLock;
  let release: () => void;
  initLock = new Promise<void>((resolve) => { release = resolve; });
  await oldLock;
  return release!;
}

export class AcpRuntimeManager extends EventEmitter {
  private process: AcpProcess | null = null;
  private sessionId: string | null = null;
  private initialized = false;
  private pendingPermissions = new Map<number | string, PendingPermission>();
  private autoApprove = false;
  private capabilities: AcpAgentCapabilities | undefined = undefined;

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

    const maxAttempts = 3;
    let lastErr: Error | undefined;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        await this.startOnce();
        return;
      } catch (err) {
        lastErr = err instanceof Error ? err : new Error(String(err));
        console.warn(`[ACP] start attempt ${attempt}/${maxAttempts} failed for ${this.options.agentName}: ${lastErr.message}`);
        this.cleanupProcess();
        if (attempt < maxAttempts) {
          const delay = attempt * 2000;
          console.log(`[ACP] retrying ${this.options.agentName} in ${delay}ms...`);
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
    }
    const finalErr = lastErr ?? new Error(`ACP runtime failed to start for ${this.options.agentName}`);
    this.emitAcpEvent({ sessionUpdate: 'error', sessionId: this.sessionId ?? undefined, error: finalErr.message });
    throw finalErr;
  }

  private cleanupProcess(): void {
    if (this.process) {
      try {
        this.process.kill('SIGTERM');
      } catch {
        // ignore
      }
      this.process = null;
    }
    this.sessionId = null;
    this.initialized = false;
    void endAgentSession(this.id, 'normal');
  }

  private async startOnce(): Promise<void> {
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

    if (this.provider.autoApprove) {
      this.setAutoApprove(true);
    }

    this.process.on('notification', (method: string, params: unknown, id?: number | string) => {
      this.handleNotification(method, params, id);
    });

    this.process.on('stderr', (text: string) => {
      // Log startup stderr to console so Kimi internal errors (-32603 etc.) are
      // visible without relying on the renderer ACP event surface.
      if (!this.initialized) {
        console.error(`[ACP] stderr from ${this.options.agentName}: ${text.trim()}`);
      }
      this.emitAcpEvent({ sessionUpdate: 'stderr', sessionId: this.sessionId ?? undefined, text });
    });

    this.process.on('error', (err: Error) => {
      this.emitAcpEvent({ sessionUpdate: 'error', sessionId: this.sessionId ?? undefined, error: err.message });
    });

    this.process.on('exit', (code: number | null, signal: string | null) => {
      void endAgentSession(this.id, 'normal');
      this.emitAcpEvent({
        sessionUpdate: 'error',
        sessionId: this.sessionId ?? undefined,
        error: `ACP process exited (code=${code}, signal=${signal})`,
      });
    });

    this.process.start();

    // Serialize the initialize handshake across all ACP runtimes to avoid Kimi
    // shared-global-state races that surface as -32603 internal errors.
    const releaseLock = await acquireInitLock();
    let initResult: Record<string, unknown>;
    let sessionResult: Record<string, unknown>;
    try {
      initResult = (await this.process.request('initialize', {
        protocolVersion: 1,
        capabilities: this.provider.defaultCapabilities,
        clientInfo: { name: 'acp-desktop', version: '1.0.0' },
      })) as Record<string, unknown>;

      sessionResult = (await this.process.request('session/new', {
        mcpServers: [],
        cwd: this.options.workDir,
      })) as Record<string, unknown>;
    } finally {
      releaseLock();
    }

    this.sessionId = (sessionResult.sessionId as string) ?? null;
    this.initialized = true;
    this.capabilities = (initResult.agentCapabilities as AcpAgentCapabilities) ?? {};

    if (this.options.agentId != null) {
      void (async () => {
        const result = await startAgentSession(this.id, this.options.agentId!, this.options.projectId);
        if (!result.ok) {
          this.notifySessionStartFailed(result.status, result.message);
        }
      })();
    }

    this.emitAcpEvent({
      sessionUpdate: 'initialized',
      sessionId: this.sessionId ?? '',
      capabilities: this.capabilities,
      agentInfo: (initResult.agentInfo as AcpAgentInfo) ?? { name: this.provider.displayName },
    });

    this.process.notify('session/list_commands', { sessionId: this.sessionId });

    // Restore the automatic onboarding kickoff that the PTY fallback path
    // has always provided. The ACP path (e.g., `kimi acp`) no longer shows
    // a banner, so the agent would otherwise sit idle until the user typed
    // something manually. Prefer the Wave-D boot prompt when the orchestrator
    // supplies one; otherwise synthesize a code-generated onboarding prompt
    // so we never rely on per-agent markdown files or the "report as" skill.
    //
    // CRITICAL: pre-fetch identity/mail for ACP before the first turn. Kimi's
    // ACP adapter crashes with -32603 if the agent emits a tool call before the
    // session is fully initialized, so we must embed the data instead of asking
    // the agent to curl it on turn one.
    let kickoff = this.options.bootPrompt?.trim() ?? '';
    if (!kickoff) {
      try {
        const [profile, unreadCount] = await Promise.all([
          acpApiGetAgentProfile(this.options.agentName),
          acpApiGetUnreadMailCount(this.options.agentName),
        ]);
        console.log(`[ACP] boot prompt data for ${this.options.agentName}: profile=${profile ? 'present' : 'missing'} unread=${unreadCount ?? 'null'}`);
        kickoff = buildAgentBootPrompt(this.options.agentName, { profile, unreadCount });
      } catch (err) {
        console.warn(`[ACP] failed to pre-fetch boot data for ${this.options.agentName}:`, err);
        kickoff = buildAgentBootPrompt(this.options.agentName);
      }
    }
    this.prompt(kickoff).catch((err) => {
      console.error(`[ACP] Failed to send onboarding kickoff for ${this.options.agentName}:`, err);
    });
  }

  async prompt(text: string): Promise<void> {
    const prompt: AcpSendContentBlock[] = [{ type: 'text', text }];
    this.sendPrompt(prompt);
  }

  async sendMessage(content: AcpSendContentBlock[]): Promise<void> {
    if (!this.process || !this.sessionId) {
      throw new Error('ACP runtime not initialized');
    }

    const supportsImage = Boolean(this.capabilities?.promptCapabilities?.image);
    const prompt: AcpSendContentBlock[] = supportsImage
      ? content
      : [{ type: 'text', text: this.buildMarkdownFallback(content) }];
    this.sendPrompt(prompt);
  }

  private sendPrompt(prompt: AcpSendContentBlock[]): void {
    if (!this.process || !this.sessionId) {
      throw new Error('ACP runtime not initialized');
    }

    const sessionId = this.sessionId;
    const PROMPT_TIMEOUT_MS = 120_000;
    let settled = false;

    // Defensive timeout: if the runtime streams all content but never returns a
    // session/prompt result (the image-paste "Answering…" hang), fail the turn
    // so the activity spinner clears instead of spinning forever.
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => {
        reject(new Error(`session/prompt timed out after ${PROMPT_TIMEOUT_MS}ms`));
      }, PROMPT_TIMEOUT_MS);
    });

    // Send prompt without awaiting — the response arrives as streaming notifications.
    Promise.race([
      this.process.request('session/prompt', { sessionId, prompt }),
      timeoutPromise,
    ])
      .then((result) => {
        if (settled) return;
        settled = true;
        // Kimi signals turn completion by returning { stopReason } from the
        // session/prompt request, not via a session/update notification. Convert
        // that response into the canonical turn_complete event so the renderer
        // clears its activity spinner. If no stopReason is provided, default to
        // 'end_turn' so the turn never hangs in an answering/thinking state.
        const stopReason =
          typeof (result as Record<string, unknown>)?.stopReason === 'string'
            ? ((result as Record<string, unknown>).stopReason as string)
            : 'end_turn';
        this.emitAcpEvent({
          sessionUpdate: 'turn_complete',
          sessionId,
          stopReason,
        });
      })
      .catch((err) => {
        if (settled) return;
        settled = true;
        this.emitAcpEvent({ sessionUpdate: 'error', sessionId, error: err.message });
      });
  }

  private buildMarkdownFallback(content: AcpSendContentBlock[]): string {
    const hasImage = content.some((block) => block.type === 'image');
    const parts: string[] = hasImage ? ['[Image pasted into chat context]', ''] : [];

    for (const block of content) {
      if (block.type === 'text') {
        parts.push(block.text);
      } else if (block.type === 'image') {
        parts.push(`![Pasted image](data:${block.mimeType};base64,${block.data})`);
      }
    }

    return parts.join('\n');
  }

  cancel(): void {
    if (!this.process || !this.sessionId) return;
    this.process.notify('session/cancel', { sessionId: this.sessionId });
    // Defensively emit turn_complete so the renderer clears the activity spinner
    // even if the runtime doesn't respond with its own completion event.
    this.emitAcpEvent({
      sessionUpdate: 'turn_complete',
      sessionId: this.sessionId,
      stopReason: 'cancel',
    });
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
    void endAgentSession(this.id, 'normal');
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

  private notifySessionStartFailed(status: number | undefined, message: string): void {
    const payload: AgentSessionStartFailedPayload = {
      agentName: this.options.agentName,
      terminalId: this.id,
      status,
      message,
    };
    BrowserWindow.getAllWindows().forEach((win) => {
      if (!win.isDestroyed() && !win.webContents.isDestroyed()) {
        win.webContents.send(IPC_CHANNELS.AGENT_SESSION_START_FAILED, payload);
      }
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
      return { type: 'content', content: { type: 'text', text: sanitizeAcpDisplayText(String(inner.text ?? '')) } };
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
    return { type: 'content', content: { type: 'text', text: sanitizeAcpDisplayText(content) } };
  }

  // Flat text object fallback.
  if (typeof content === 'object' && (content as Record<string, unknown>).text !== undefined) {
    return {
      type: 'content',
      content: { type: 'text', text: sanitizeAcpDisplayText(String((content as Record<string, unknown>).text)) },
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
