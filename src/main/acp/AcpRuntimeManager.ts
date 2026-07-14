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

  // Inactivity watchdog while a session/prompt is pending. A fixed timeout
  // falsely kills slow-but-healthy turns (tool calls, long reasoning). We
  // only declare a hang when the runtime has been completely silent for a
  // while, and we auto-restart when that happens.
  private promptPending = false;
  private promptIdleTicks = 0;
  private inactivityTimer: ReturnType<typeof setInterval> | null = null;
  private promptSettledRef: { current: boolean } | null = null;

  // Kimi's ACP runtime does not handle concurrent session/prompt requests on
  // the same session; overlapping calls produce -32603 internal errors and can
  // cause the in-flight turn to return an empty end_turn. Queue prompts so only
  // one is ever in flight at a time.
  private promptQueue: Array<{ prompt: AcpSendContentBlock[]; resolve: () => void }> = [];
  private promptInFlight = false;

  // When the user is actively typing to an agent, suppress auto-injected mail
  // notices so the agent doesn't get trapped in a mail-processing loop that
  // drowns out the human. User prompts refresh this timestamp; mail injection
  // checks it and is dropped during the cooldown window.
  private lastUserPromptTime = 0;
  private static readonly MAIL_COOLDOWN_MS = 5 * 60 * 1000;

  // Crash-recovery state. We track whether a kill was intentional so an
  // unexpected process exit can auto-restart, and we back off so a repeatedly
  // crashing runtime (e.g., Kimi cold-init race on Windows) doesn't spin forever.
  private intentionalKill = false;
  private restarting = false;
  private restartCount = 0;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly MAX_RESTARTS = 5;

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

  private startPromptWatchdog(): void {
    const WATCHDOG_INTERVAL_MS = 15_000;
    const PROMPT_IDLE_MS = 120_000;
    const WATCHDOG_IDLE_TICKS = Math.ceil(PROMPT_IDLE_MS / WATCHDOG_INTERVAL_MS);
    this.promptPending = true;
    this.promptIdleTicks = 0;
    if (this.inactivityTimer) clearInterval(this.inactivityTimer);
    this.inactivityTimer = setInterval(() => {
      if (!this.promptPending) {
        this.stopPromptWatchdog();
        return;
      }
      // If the OS process is already gone, there will never be another
      // notification. Fail the turn immediately and restart rather than waiting
      // for the full idle timeout.
      if (!this.process?.isRunning()) {
        const message = `ACP process for ${this.options.agentName} died while a turn was pending; restarting runtime`;
        console.warn(`[ACP ${this.options.agentName}] ${message}`);
        this.stopPromptWatchdog();
        this.emitAcpEvent({
          sessionUpdate: 'error',
          sessionId: this.sessionId ?? '',
          error: message,
        });
        void this.restart();
        return;
      }
      this.promptIdleTicks++;
      if (this.promptIdleTicks >= WATCHDOG_IDLE_TICKS) {
        if (this.promptSettledRef?.current) {
          this.stopPromptWatchdog();
          return;
        }
        this.promptSettledRef!.current = true;
        const message = `No response from ${this.options.agentName} for ${Math.round((this.promptIdleTicks * WATCHDOG_INTERVAL_MS) / 1000)}s while a turn was pending; restarting runtime`;
        console.warn(`[ACP ${this.options.agentName}] ${message}`);
        this.stopPromptWatchdog();
        this.emitAcpEvent({
          sessionUpdate: 'error',
          sessionId: this.sessionId ?? '',
          error: message,
        });
        void this.restart();
      }
    }, WATCHDOG_INTERVAL_MS);
  }

  private stopPromptWatchdog(): void {
    this.promptPending = false;
    if (this.inactivityTimer) {
      clearInterval(this.inactivityTimer);
      this.inactivityTimer = null;
    }
    this.promptSettledRef = null;
  }

  private markPromptActivity(): void {
    if (this.promptPending) {
      this.promptIdleTicks = 0;
    }
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
    this.stopPromptWatchdog();
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
      // Kimi dumps internal diagnostics (including -32603 errors) to stderr.
      // Keep them visible in main-process logs even after init so we can diagnose
      // crashes that don't produce a clean exit event.
      const trimmed = text.trim();
      if (trimmed) {
        console.error(`[ACP ${this.options.agentName}] stderr: ${trimmed}`);
      }
      this.emitAcpEvent({ sessionUpdate: 'stderr', sessionId: this.sessionId ?? undefined, text });
    });

    this.process.on('error', (err: Error) => {
      console.error(`[ACP ${this.options.agentName}] process error:`, err);
      this.emitAcpEvent({ sessionUpdate: 'error', sessionId: this.sessionId ?? undefined, error: err.message });
      this.scheduleRestart(`process error: ${err.message}`);
    });

    this.process.on('exit', (code: number | null, signal: string | null) => {
      const wasIntentional = this.intentionalKill;
      const wasHealthy = this.initialized;
      this.intentionalKill = false;
      console.warn(`[ACP ${this.options.agentName}] process exited (code=${code}, signal=${signal})`);
      this.stopPromptWatchdog();
      this.process = null;
      this.sessionId = null;
      this.initialized = false;
      void endAgentSession(this.id, 'normal');
      this.emitAcpEvent({
        sessionUpdate: 'error',
        sessionId: this.sessionId ?? undefined,
        error: `ACP process exited (code=${code}, signal=${signal})`,
      });
      // If the runtime died unexpectedly while it was healthy, try to bring it
      // back. Intentional kills (manual restart/quit) and startup-time crashes
      // are handled by the caller.
      if (!wasIntentional && wasHealthy) {
        this.scheduleRestart(`process exited (code=${code}, signal=${signal})`);
      }
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
    this.markHealthy();

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
    this.systemPrompt(kickoff).catch((err) => {
      console.error(`[ACP] Failed to send onboarding kickoff for ${this.options.agentName}:`, err);
    });
  }

  async prompt(text: string): Promise<void> {
    if (!this.process?.isRunning() || !this.sessionId) {
      throw new Error('ACP runtime not initialized');
    }
    this.lastUserPromptTime = Date.now();
    await this.systemPrompt(text);
  }

  private async systemPrompt(text: string): Promise<void> {
    if (!this.process?.isRunning() || !this.sessionId) {
      throw new Error('ACP runtime not initialized');
    }
    const prompt: AcpSendContentBlock[] = [{ type: 'text', text }];
    await this.sendPrompt(prompt);
  }

  async sendMessage(content: AcpSendContentBlock[]): Promise<void> {
    if (!this.process?.isRunning() || !this.sessionId) {
      throw new Error('ACP runtime not initialized');
    }

    this.lastUserPromptTime = Date.now();
    const supportsImage = Boolean(this.capabilities?.promptCapabilities?.image);
    const prompt: AcpSendContentBlock[] = supportsImage
      ? content
      : [{ type: 'text', text: this.buildMarkdownFallback(content) }];
    await this.sendPrompt(prompt);
  }

  /**
   * Inject a mail notice as a user-turn prompt. Suppressed when the human user
   * has recently sent a direct message to this agent, to prevent mail loops
   * from drowning out the user.
   */
  async injectMail(text: string): Promise<boolean> {
    if (!this.process?.isRunning() || !this.sessionId) {
      console.warn(`[ACP ${this.options.agentName}] injectMail skipped: runtime not initialized`);
      return false;
    }

    const elapsed = Date.now() - this.lastUserPromptTime;
    if (this.lastUserPromptTime > 0 && elapsed < AcpRuntimeManager.MAIL_COOLDOWN_MS) {
      const remaining = Math.ceil((AcpRuntimeManager.MAIL_COOLDOWN_MS - elapsed) / 1000);
      console.log(`[ACP ${this.options.agentName}] injectMail suppressed: user active ${Math.round(elapsed / 1000)}s ago, cooldown ${remaining}s remaining`);
      return false;
    }

    const prompt: AcpSendContentBlock[] = [{ type: 'text', text }];
    await this.sendPrompt(prompt);
    return true;
  }

  private sendPrompt(prompt: AcpSendContentBlock[]): Promise<void> {
    if (!this.process?.isRunning() || !this.sessionId) {
      const message = 'ACP runtime not initialized';
      console.error(`[ACP ${this.options.agentName}] ${message}`);
      this.emitAcpEvent({ sessionUpdate: 'error', sessionId: this.sessionId ?? '', error: message });
      this.scheduleRestart('runtime not running when prompt sent');
      return Promise.resolve();
    }

    if (this.promptInFlight) {
      return new Promise((resolve) => {
        this.promptQueue.push({ prompt, resolve });
        console.log(`[ACP ${this.options.agentName}] prompt queued (queueDepth=${this.promptQueue.length}, session=${this.sessionId})`);
      });
    }

    this.executePrompt(prompt);
    return Promise.resolve();
  }

  private executePrompt(prompt: AcpSendContentBlock[], resolveDispatched?: () => void): void {
    if (!this.process?.isRunning() || !this.sessionId) {
      const message = 'ACP runtime not initialized';
      console.error(`[ACP ${this.options.agentName}] ${message}`);
      this.emitAcpEvent({ sessionUpdate: 'error', sessionId: this.sessionId ?? '', error: message });
      this.scheduleRestart('runtime not running when prompt sent');
      resolveDispatched?.();
      this.promptInFlight = false;
      this.drainPromptQueue();
      return;
    }

    this.promptInFlight = true;
    resolveDispatched?.();
    const sessionId = this.sessionId;
    const preview = prompt.map((b) => (b.type === 'text' ? b.text : `[${b.type}]`)).join(' ').slice(0, 120);
    console.log(`[ACP ${this.options.agentName}] >>> session/prompt (session=${sessionId}): ${preview}`);
    const settledRef = { current: false };
    this.promptSettledRef = settledRef;

    // Start the inactivity watchdog. Slow-but-healthy turns (long tool calls,
    // heavy reasoning) keep emitting notifications and reset the watchdog. We
    // only treat the runtime as hung when it has been completely silent for
    // PROMPT_IDLE_MS. A hard ceiling (PROMPT_MAX_MS) still guards against a
    // runtime that streams meaningless keepalives forever.
    this.startPromptWatchdog();
    const PROMPT_MAX_MS = 600_000;
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => {
        reject(new Error(`session/prompt exceeded maximum time of ${PROMPT_MAX_MS}ms`));
      }, PROMPT_MAX_MS);
    });

    // Send prompt without awaiting — the response arrives as streaming notifications.
    // Pass timeoutMs=0 so the per-request timeout in AcpProcess doesn't fire while
    // a healthy turn is still streaming; our manager-level watchdog handles hangs.
    Promise.race([
      this.process.request('session/prompt', { sessionId, prompt }, 0),
      timeoutPromise,
    ])
      .then((result) => {
        if (settledRef.current) return;
        settledRef.current = true;
        this.stopPromptWatchdog();
        this.markHealthy();
        const stopReason =
          typeof (result as Record<string, unknown>)?.stopReason === 'string'
            ? ((result as Record<string, unknown>).stopReason as string)
            : 'end_turn';
        console.log(`[ACP ${this.options.agentName}] <<< session/prompt result (session=${sessionId}): stopReason=${stopReason}`);
        this.emitAcpEvent({
          sessionUpdate: 'turn_complete',
          sessionId,
          stopReason,
        });
        // Visibility aid: log the raw result so we can see what the runtime
        // actually returned when the transcript appears empty.
        console.log(`[ACP ${this.options.agentName}] <<< session/prompt raw result (session=${sessionId}):`, JSON.stringify(result).slice(0, 2000));
      })
      .catch((err) => {
        if (settledRef.current) return;
        settledRef.current = true;
        this.stopPromptWatchdog();
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[ACP ${this.options.agentName}] session/prompt failed (session=${sessionId}):`, err);
        this.emitAcpEvent({ sessionUpdate: 'error', sessionId, error: message });
        // A JSON-RPC error on the actual prompt call usually means the runtime
        // is in a broken state (not just slow). Kill and restart it so the next
        // turn starts from a clean process instead of silently returning empty.
        this.scheduleRestart(`session/prompt failed: ${message}`);
      })
      .finally(() => {
        this.promptInFlight = false;
        this.drainPromptQueue();
      });
  }

  private drainPromptQueue(): void {
    if (!this.process?.isRunning() || !this.sessionId) {
      // Runtime is down (likely restarting after an error). Fail any queued
      // prompts so the user sees feedback rather than an eternal spinner.
      if (this.promptQueue.length > 0) {
        console.warn(`[ACP ${this.options.agentName}] dropping ${this.promptQueue.length} queued prompt(s): runtime not initialized`);
        for (const queued of this.promptQueue) {
          const preview = queued.prompt.map((b) => (b.type === 'text' ? b.text : `[${b.type}]`)).join(' ').slice(0, 80);
          this.emitAcpEvent({ sessionUpdate: 'error', sessionId: this.sessionId ?? '', error: `Prompt dropped, runtime restarting: ${preview}` });
        }
        this.promptQueue = [];
      }
      return;
    }

    const next = this.promptQueue.shift();
    if (next) {
      console.log(`[ACP ${this.options.agentName}] draining prompt queue (remaining=${this.promptQueue.length}, session=${this.sessionId})`);
      this.executePrompt(next.prompt, next.resolve);
    }
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
    const sessionId = this.sessionId;
    if (this.process && sessionId) {
      this.process.notify('session/cancel', { sessionId });
    }
    // Always emit turn_complete so the renderer clears the activity spinner,
    // even if the runtime process has already crashed and the cancel notify
    // could not be delivered.
    this.emitAcpEvent({
      sessionUpdate: 'turn_complete',
      sessionId: sessionId ?? '',
      stopReason: 'cancel',
    });
  }

  setMode(mode: string): void {
    if (!this.process || !this.sessionId) return;
    this.process.notify('session/set_mode', { sessionId: this.sessionId, modeId: mode });
  }

  kill(): void {
    this.intentionalKill = true;
    this.stopPromptWatchdog();
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    if (!this.process) return;
    this.process.kill('SIGTERM');
    this.process = null;
    this.sessionId = null;
    this.initialized = false;
    void endAgentSession(this.id, 'normal');
  }

  async restart(): Promise<void> {
    if (this.restarting) return;
    this.restarting = true;
    console.log(`[ACP ${this.options.agentName}] Restarting runtime`);
    this.kill();
    // Brief pause so the OS can release stdio handles / file locks before we
    // spawn a replacement (especially important on Windows).
    await new Promise((resolve) => setTimeout(resolve, 500));
    try {
      await this.start();
      this.markHealthy();
      console.log(`[ACP ${this.options.agentName}] Runtime restarted`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[ACP ${this.options.agentName}] Runtime restart failed:`, err);
      this.emitAcpEvent({
        sessionUpdate: 'error',
        sessionId: this.sessionId ?? '',
        error: `Runtime restart failed: ${message}`,
      });
      this.scheduleRestart(`restart failed: ${message}`);
    } finally {
      this.restarting = false;
    }
  }

  private scheduleRestart(reason: string): void {
    if (this.restartTimer) return;
    if (this.restartCount >= this.MAX_RESTARTS) {
      const message = `Runtime keeps failing (${this.restartCount} restarts): ${reason}`;
      console.error(`[ACP ${this.options.agentName}] ${message}`);
      this.emitAcpEvent({ sessionUpdate: 'error', sessionId: this.sessionId ?? '', error: message });
      return;
    }
    this.restartCount++;
    const delay = Math.min(30_000, 1_000 * Math.pow(2, this.restartCount - 1));
    console.warn(`[ACP ${this.options.agentName}] scheduling restart #${this.restartCount} in ${delay}ms: ${reason}`);
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      void this.restart();
    }, delay);
  }

  private markHealthy(): void {
    if (this.restartCount > 0) {
      console.log(`[ACP ${this.options.agentName}] runtime healthy; reset restart counter`);
      this.restartCount = 0;
    }
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
    this.markPromptActivity();
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
    console.log(`[ACP ${this.options.agentName}] notification: ${sessionUpdate}`);

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
