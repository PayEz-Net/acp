import type { Config } from '../../config.js';

export type AgentSseState = 'connected' | 'reconnecting' | 'failed' | 'stopped';

interface AgentConnection {
  agent: string;
  state: AgentSseState;
  consecutiveFailures: number;
  controller: AbortController | null;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  degradedRetryTimer: ReturnType<typeof setTimeout> | null;
}

type MailEventHandler = (agent: string, data: Record<string, unknown>) => void;

const BACKOFF_BASE_MS = 2000;
const BACKOFF_MAX_MS = 60_000;
const MAX_CONSECUTIVE_FAILURES = 5;
const DEGRADED_RETRY_MS = 15 * 1000; // 15s — fast recovery for agent coordination

function backoffDelay(failures: number): number {
  return Math.min(BACKOFF_BASE_MS * Math.pow(2, failures), BACKOFF_MAX_MS);
}

/**
 * Manages upstream SSE connections to idealvibe.online per agent.
 * One connection per agent. Auto-reconnect with exponential backoff.
 * After MAX_CONSECUTIVE_FAILURES, marks agent as degraded and retries every 5 minutes.
 */
export class UpstreamSseManager {
  private connections = new Map<string, AgentConnection>();
  private handlers: MailEventHandler[] = [];
  private cfg: Config;
  private running = false;

  constructor(cfg: Config) {
    this.cfg = cfg;
  }

  onMailEvent(handler: MailEventHandler): void {
    this.handlers.push(handler);
  }

  private emit(agent: string, data: Record<string, unknown>): void {
    for (const handler of this.handlers) {
      try {
        handler(agent, data);
      } catch {
        // handler errors don't crash the manager
      }
    }
  }

  getStatus(): Record<string, AgentSseState> {
    const result: Record<string, AgentSseState> = {};
    for (const [agent, conn] of this.connections) {
      result[agent] = conn.state;
    }
    return result;
  }

  /**
   * Start SSE connections for a list of agents.
   */
  start(agents: string[]): void {
    this.running = true;
    for (const agent of agents) {
      if (!this.connections.has(agent)) {
        this.connections.set(agent, {
          agent,
          state: 'reconnecting',
          consecutiveFailures: 0,
          controller: null,
          reconnectTimer: null,
          degradedRetryTimer: null,
        });
      }
      this.connect(agent);
    }
  }

  /**
   * Stop all upstream SSE connections.
   */
  stop(): void {
    this.running = false;
    for (const [, conn] of this.connections) {
      conn.state = 'stopped';
      conn.controller?.abort();
      if (conn.reconnectTimer) clearTimeout(conn.reconnectTimer);
      if (conn.degradedRetryTimer) clearTimeout(conn.degradedRetryTimer);
    }
    this.connections.clear();
  }

  /**
   * Refresh all upstream SSE connections (stop + restart).
   * Use when connections have gone stale or degraded.
   */
  refresh(agents: string[]): void {
    console.log(`[SSE] Refreshing upstream connections for ${agents.length} agents`);
    this.stop();
    this.start(agents);
  }

  private buildAuthHeaders(): Record<string, string> {
    return {
      'X-Vibe-Client-Id': this.cfg.vibeClientId,
      'X-Vibe-Client-Secret': this.cfg.vibeHmacKey,
      'X-Vibe-User-Id': this.cfg.vibeUserId,
    };
  }

  private async connect(agent: string): Promise<void> {
    if (!this.running) return;
    const conn = this.connections.get(agent);
    if (!conn) return;

    // Abort any existing connection
    conn.controller?.abort();
    conn.controller = new AbortController();

    const url = `${this.cfg.vibeApiUrl}/v1/agentmail/stream?agent=${agent}`;
    const headers = this.buildAuthHeaders();

    try {
      const res = await fetch(url, {
        headers,
        signal: conn.controller.signal,
      });

      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }

      conn.state = 'connected';
      conn.consecutiveFailures = 0;
      console.log(`[SSE] ${agent}: connected`);

      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (this.running) {
        const { value, done } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        // Parse SSE frames: separated by double newline
        const frames = buffer.split('\n\n');
        buffer = frames.pop() ?? '';

        for (const frame of frames) {
          if (!frame.trim()) continue;
          this.parseFrame(agent, frame);
        }
      }

      // Stream ended cleanly
      if (this.running) {
        console.log(`[SSE] ${agent}: stream ended, reconnecting`);
        this.scheduleReconnect(agent);
      }
    } catch (err: any) {
      if (err.name === 'AbortError' && !this.running) return; // intentional stop

      conn.consecutiveFailures++;
      console.warn(`[SSE] ${agent}: error (${conn.consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES}): ${err.message}`);

      if (conn.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        conn.state = 'failed';
        console.error(`[SSE] ${agent}: degraded after ${MAX_CONSECUTIVE_FAILURES} failures, retrying in ${DEGRADED_RETRY_MS / 1000}s`);
        const jitter = Math.random() * 3000; // 0-3s jitter to avoid thundering herd
        conn.degradedRetryTimer = setTimeout(() => {
          if (!this.running) return;
          console.log(`[SSE] ${agent}: degraded retry — attempting reconnect`);
          conn.consecutiveFailures = 0;
          conn.state = 'reconnecting';
          this.connect(agent);
        }, DEGRADED_RETRY_MS + jitter);
      } else {
        this.scheduleReconnect(agent);
      }
    }
  }

  private scheduleReconnect(agent: string): void {
    const conn = this.connections.get(agent);
    if (!conn || !this.running) return;

    conn.state = 'reconnecting';
    const delay = backoffDelay(conn.consecutiveFailures);
    console.log(`[SSE] ${agent}: reconnecting in ${delay}ms`);
    conn.reconnectTimer = setTimeout(() => this.connect(agent), delay);
  }

  private parseFrame(agent: string, frame: string): void {
    let eventType = '';
    let dataStr = '';

    for (const line of frame.split('\n')) {
      if (line.startsWith('event: ')) {
        eventType = line.slice(7).trim();
      } else if (line.startsWith('data: ')) {
        dataStr += line.slice(6);
      } else if (line.startsWith('data:')) {
        dataStr += line.slice(5);
      }
    }

    if (!dataStr) return;

    try {
      const data = JSON.parse(dataStr);

      if (eventType === 'new-mail' || eventType === 'mail') {
        this.emit(agent, data);
      } else if (eventType === 'connected') {
        // Initial connection confirmation — already logged
      }
      // Other event types can be added here
    } catch {
      // Malformed JSON — skip
    }
  }
}
