import type { Config } from '../../config.js';
import { ensureValidToken } from '../auth/tokenManager.js';
import { getStartedProjectId } from '../projects/startedProject.js';
import * as signalR from '@microsoft/signalr';

export type AgentSseState = 'connected' | 'reconnecting' | 'failed' | 'stopped';

interface AgentConnection {
  agent: string;
  state: AgentSseState;
}

type MailEventHandler = (agent: string, data: Record<string, unknown>) => void;

/**
 * Upstream SignalR manager for cloud agent-mail push notifications.
 *
 * Replaces the legacy per-agent SSE upstream connections with a single
 * SignalR connection to /hubs/agentmail. SignalR + Redis backplane survives
 * multi-pod cloud deployments, which is why SSE push was silently dropping
 * events when the mail-send landed on a different pod than the SSE stream.
 *
 * The public interface mirrors UpstreamSseManager so server.js/shutdown can
 * swap it in without wider changes.
 */
/**
 * How often the dropped-notification summary is emitted, when there is anything
 * to say. Deliberately NOT per-drop: a line per drop is what produced 251
 * identical warnings in one session, which is the volume at which a log stops
 * being read at all.
 */
const DROP_SUMMARY_INTERVAL_MS = 5 * 60_000;

export class UpstreamSignalRManager {
  private connection: signalR.HubConnection | null = null;
  private agents = new Set<string>();
  /**
   * Dropped-notification accounting.
   *
   * Every drop below is correct behaviour, and every one of them was invisible.
   * 251 notifications for a project this rig was not engaged on went to a
   * console.warn nobody reads — from the OTHER project's side that is simply
   * "we mailed them and never got a reply", indistinguishable from everyone
   * being busy. A log-spotter cannot catch this class: a grep only fires on
   * patterns someone predicted, and the whole problem is that nobody predicted
   * it. The fix is not a better filter, it is making the condition a number
   * that gets read whether or not anyone went looking.
   *
   * `window` resets each time a summary is emitted; `lifetime` never does, so
   * a quiet window still reports an accurate running total.
   */
  private dropWindow = new Map<string, number>();
  private dropLifetime = new Map<string, number>();
  private dropSummaryTimer: ReturnType<typeof setInterval> | null = null;
  private states = new Map<string, AgentConnection>();
  private handlers: MailEventHandler[] = [];
  private cfg: Config;
  private running = false;
  private connecting = false;

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
    for (const [agent, conn] of this.states) {
      result[agent] = conn.state;
    }
    return result;
  }

  start(agents: string[]): void {
    this.running = true;
    if (!this.dropSummaryTimer) {
      this.dropSummaryTimer = setInterval(() => this.emitDropSummary(), DROP_SUMMARY_INTERVAL_MS);
      // Don't hold the process open for a reporting timer.
      this.dropSummaryTimer.unref?.();
    }
    for (const agent of agents) {
      this.agents.add(agent);
      if (!this.states.has(agent)) {
        this.states.set(agent, { agent, state: 'reconnecting' });
      }
    }
    void this.ensureConnection();
  }

  stop(): void {
    this.running = false;
    if (this.dropSummaryTimer) {
      clearInterval(this.dropSummaryTimer);
      this.dropSummaryTimer = null;
    }
    // Flush before going quiet — drops accumulated since the last summary would
    // otherwise be discarded at shutdown, which is exactly the silence this
    // counter exists to remove.
    this.emitDropSummary();
    for (const conn of this.states.values()) {
      conn.state = 'stopped';
    }
    if (this.connection) {
      this.connection.stop().catch((err) => {
        console.warn('[SignalR] stop error:', err);
      });
      this.connection = null;
    }
  }

  refresh(agents: string[]): void {
    console.log(`[SignalR] Refreshing upstream subscriptions for ${agents.length} agents`);
    this.stop();
    this.states.clear();
    this.agents.clear();
    this.start(agents);
  }

  private async buildConnection(): Promise<signalR.HubConnection> {
    const token = await ensureValidToken(this.cfg.idpUrl, 'ensureValidToken@signalr');
    if (!token) {
      throw new Error('NO_SESSION');
    }

    const url = `${this.cfg.vibeApiUrl}/hubs/agentmail`;
    const conn = new signalR.HubConnectionBuilder()
      .withUrl(url, {
        accessTokenFactory: async () => {
          const fresh = await ensureValidToken(this.cfg.idpUrl, 'ensureValidToken@signalr');
          return fresh || token;
        },
        transport: signalR.HttpTransportType.WebSockets
          | signalR.HttpTransportType.ServerSentEvents
          | signalR.HttpTransportType.LongPolling,
      })
      .withAutomaticReconnect({
        nextRetryDelayInMilliseconds: (retryContext) => {
          // Exponential backoff: 0ms, 2s, 4s, 8s ... cap at 30s
          const delay = Math.min(2000 * Math.pow(2, retryContext.previousRetryCount), 30000);
          return delay;
        },
      })
      .configureLogging(signalR.LogLevel.Warning)
      .build();

    conn.on('ReceiveNotification', (notification: Record<string, unknown>) => {
      const data = notification.data as Record<string, unknown> | undefined;
      console.log('[SignalR] ReceiveNotification:', {
        event_type: notification.event_type,
        message_id: data?.message_id,
        to_agent: data?.to_agent,
        from_agent: data?.from_agent,
      });
      this.handleNotification(notification);
    });

    conn.on('Subscribed', (result: { subscribed?: string[]; denied?: string[] }) => {
      console.log('[SignalR] Subscribed event:', result);
    });

    // The agent-mail hub broadcasts broader project/agent events; this
    // upstream consumer only cares about mail notifications. Register no-op
    // handlers for the rest so SignalR stops spamming "No client method found".
    const noOpMethods = [
      'connected',
      'project-lifecycle-changed',
      'project-kanban-active-count-changed',
      'agent-status-changed',
      'project-activity-event',
    ];
    for (const method of noOpMethods) {
      conn.on(method, () => { /* ignored by mail upstream */ });
    }

    conn.onreconnecting((err) => {
      console.warn('[SignalR] reconnecting:', err?.message || 'connection lost');
      this.setAllStates('reconnecting');
    });

    conn.onreconnected(() => {
      console.log('[SignalR] reconnected');
      void this.subscribeAgents();
    });

    conn.onclose((err) => {
      if (this.running) {
        console.warn('[SignalR] closed unexpectedly:', err?.message || 'no error');
        this.setAllStates('reconnecting');
        // Automatic reconnect handles most cases; if it gives up, manually restart.
        setTimeout(() => this.ensureConnection(), 5000);
      }
    });

    return conn;
  }

  private async ensureConnection(): Promise<void> {
    if (!this.running || this.connecting || this.connection?.state === signalR.HubConnectionState.Connected) {
      return;
    }
    if (this.connection?.state === signalR.HubConnectionState.Connecting) {
      return;
    }

    this.connecting = true;
    try {
      if (this.connection) {
        await this.connection.stop();
      }
      this.connection = await this.buildConnection();
      await this.connection.start();
      console.log('[SignalR] connected to', this.cfg.vibeApiUrl);
      this.setAllStates('connected');
      await this.subscribeAgents();
    } catch (err: any) {
      console.warn('[SignalR] connection failed:', err.message);
      this.setAllStates('reconnecting');
      if (this.running) {
        setTimeout(() => this.ensureConnection(), 5000);
      }
    } finally {
      this.connecting = false;
    }
  }

  private async subscribeAgents(): Promise<void> {
    if (!this.connection || this.connection.state !== signalR.HubConnectionState.Connected) return;
    if (this.agents.size === 0) return;

    const agentList = Array.from(this.agents);
    try {
      const result = await this.connection.invoke<{ subscribed?: string[]; denied?: string[] }>(
        'SubscribeToAgents',
        agentList,
      );
      console.log('[SignalR] subscribed to agents:', result?.subscribed ?? agentList);
      if (result?.denied?.length) {
        console.warn('[SignalR] denied agents:', result.denied);
      }
    } catch (err: any) {
      console.warn('[SignalR] SubscribeToAgents failed:', err.message);
    }
  }

  /** Tally one dropped notification under a stable reason key. */
  private recordDrop(reason: string): void {
    this.dropWindow.set(reason, (this.dropWindow.get(reason) ?? 0) + 1);
    this.dropLifetime.set(reason, (this.dropLifetime.get(reason) ?? 0) + 1);
  }

  /**
   * Emit one summary line per reason, loudest first, then reset the window.
   * Silent when nothing was dropped — this must not become background noise, or
   * it inherits the problem it exists to solve.
   */
  private emitDropSummary(): void {
    if (this.dropWindow.size === 0) return;
    const mins = Math.round(DROP_SUMMARY_INTERVAL_MS / 60_000);
    const rows = [...this.dropWindow.entries()].sort((a, b) => b[1] - a[1]);
    const total = rows.reduce((n, [, c]) => n + c, 0);
    console.warn(
      `[SignalR] DROPPED ${total} notification(s) in the last ${mins}m — these were received and discarded, not delivered:`,
    );
    for (const [reason, count] of rows) {
      console.warn(`[SignalR]   ${count} × ${reason}  (lifetime ${this.dropLifetime.get(reason) ?? count})`);
    }
    this.dropWindow.clear();
  }

  private handleNotification(notification: Record<string, unknown>): void {
    const data = notification.data as Record<string, unknown> | undefined;

    // PROJECT GATE — the same authority every mail READ is stamped with.
    //
    // The hub routes on agent_{clientId}_{agentId} and agents are global /
    // cross-tenant, so a name match alone delivers this rig every project's
    // mail for an agent it happens to share a name with. Reads are scoped
    // (requireStartedProjectId), so those notices then 404 on read:
    // "Message not found for the specified project". The agent is told it has
    // mail that does not exist for it — and once that content is in its
    // context it cannot be taken back out.
    //
    // `project_id` is absent on servers older than the 2026-08-03 payload fix,
    // so an undefined id is passed through rather than dropped: filtering on a
    // field the server never sends would silence mail entirely. Once every
    // deployed hub stamps it, this guard can require the field instead.
    const notifiedProject = data?.project_id as number | undefined;
    const startedProject = getStartedProjectId();
    if (notifiedProject != null && startedProject != null && notifiedProject !== startedProject) {
      // Counted, not logged per-occurrence — see emitDropSummary(). At debug
      // level the individual line is still there when someone is chasing a
      // specific message_id.
      this.recordDrop(`wrong project: notified for ${notifiedProject}, this rig is engaged on ${startedProject}`);
      console.debug(
        `[SignalR] Dropping notification for project ${notifiedProject}: this rig is engaged on ${startedProject}.`,
        { event_type: notification.event_type, message_id: data?.message_id, to_agent: data?.to_agent },
      );
      return;
    }

    const toAgent = data?.to_agent as string | undefined;
    const fromAgent = data?.from_agent as string | undefined;

    if (!toAgent) {
      this.recordDrop('missing to_agent (cloud payload not routing-ready)');
      console.warn('[SignalR] Dropping notification: missing to_agent. Cloud payload is not routing-ready.', {
        event_type: notification.event_type,
        message_id: data?.message_id,
        from_agent: fromAgent,
      });
      return;
    }

    if (!this.agents.has(toAgent)) {
      this.recordDrop(`recipient "${toAgent}" not in this rig's tracked agent set`);
      console.warn(`[SignalR] Dropping notification: recipient "${toAgent}" is not in the tracked agent set.`, {
        event_type: notification.event_type,
        message_id: data?.message_id,
        from_agent: fromAgent,
      });
      return;
    }

    this.emit(toAgent, notification);
  }

  private setAllStates(state: AgentSseState): void {
    for (const conn of this.states.values()) {
      conn.state = state;
    }
  }
}
