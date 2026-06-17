/**
 * Lifecycle Hub — Wave E Stage 7 per BAPert msg 1173 + DotNetPert msg
 * 1172. Replaces lifecycle-poller.ts (msg 1154) with push-driven state
 * via the existing /hubs/agentmail SignalR hub.
 *
 * Same EventEmitter shape as the prior poller — spawn-orchestrator
 * subscribes to the same event names so its behavior is unchanged.
 * Cloud connection auto-subscribes the user to project + agent groups
 * at connect time (DotNetPert msg 1172 §4 enumeration + snapshot-on-
 * connect), so this module just listens and re-emits.
 *
 * Replaces (per `feedback_no_acknowledged_defect_ships`):
 *   - 10s polling of /v1/users/me/current-project
 *   - 10s/30s polling of /v1/projects/:id/lifecycle
 * The old lifecycle-poller.ts is deleted in this commit.
 *
 * Auth: pulls IDP access token from the same acp-api endpoint used
 * elsewhere in this main-process tree. Per
 * `feedback_idp_refresh_token_single_use`, fresh token per connect/
 * reconnect, not per tick.
 */

import { EventEmitter } from 'events';
import * as signalR from '@microsoft/signalr';
import { getAccessToken } from './auth';
import { HUB_URL } from './env';
import { getLocalSecret } from './api-server';

// Local sidecar (fixed 127.0.0.1:3001 — NOT a cloud base-URL hydra; the
// sidecar port is constant). Used only for the initial-state seed below.
const ACP_API_BASE = process.env.ACP_API_URL || 'http://127.0.0.1:3001';

// HUB_URL comes from the single cloud-environment authority (env.ts, baked at
// build time by scripts/gen-env.cjs). No `||`, no env-or-dev-93 fallback here:
// the active env is chosen at build (dev:93 / dev:prod / dist), decided once,
// throws if unset. This
// literal-defaulting line is exactly why the installed app's lifecycle
// hub never connected (dev-93 unreachable → no project-lifecycle-changed
// → spawn-orchestrator never saw RUNNING → agents never auto-started).

export type LifecycleState = 'RUNNING' | 'IDLE' | 'PAUSED' | 'INCOMPLETE';

export interface AgentStatusChangedEvent {
  agent_id: number;
  agent_name: string;
  status: 'running' | 'idle' | 'escalating' | 'coordinator' | 'unknown';
  previous_status?: string | null;
  last_action_at?: string | null;
  last_action_summary?: string | null;
}

export interface ProjectLifecycleChangedEvent {
  project_id: number;
  state: LifecycleState;
  stored_state?: string | null;
  last_state_change_at?: string | null;
  agents_running_count?: number;
  agents_idle_count?: number;
}

export interface ProjectActivityEvent {
  id: number;
  project_id: number;
  type: 'mail' | 'commit' | 'pr' | 'spawn' | 'error';
  agent_id: number | null;
  agent_name: string | null;
  summary: string;
  occurred_at: string;
}

export interface ProjectKanbanActiveCountChangedEvent {
  project_id: number;
  active_count: number;
}

const emitter = new EventEmitter();
emitter.setMaxListeners(20);

let connection: signalR.HubConnection | null = null;
let started = false;
let lastToken: string | null = null;

async function buildConnection(): Promise<signalR.HubConnection> {
  const token = await getAccessToken();
  if (!token) throw new Error('No IDP access token available for SignalR connect');
  lastToken = token;
  return new signalR.HubConnectionBuilder()
    .withUrl(HUB_URL, {
      accessTokenFactory: async () => {
        const fresh = await getAccessToken();
        if (fresh) lastToken = fresh;
        return lastToken || '';
      },
      transport: signalR.HttpTransportType.WebSockets
        | signalR.HttpTransportType.ServerSentEvents
        | signalR.HttpTransportType.LongPolling,
    })
    .withAutomaticReconnect({
      nextRetryDelayInMilliseconds: (ctx) => {
        const delays = [0, 2000, 5000, 10000, 30000];
        return delays[Math.min(ctx.previousRetryCount, delays.length - 1)];
      },
    })
    .configureLogging(signalR.LogLevel.Information)
    .build();
}

function setupHandlers(conn: signalR.HubConnection): void {
  // Server-side OnConnectedAsync sends a "Connected" greeting with
  // HubConnectionInfo. Cosmetic per DotNetPert (post msg-1174 trace);
  // SignalR logs "No client method with the name 'Connected' found"
  // if no handler exists. We swallow it (could later use as a
  // session-attached UX signal — server payload is HubConnectionInfo
  // shape). Capital-C event name matches the server's literal.
  conn.on('Connected', (_info: unknown) => {
    // intentional no-op; satisfies SignalR's handler-presence check
  });
  conn.on('agent-status-changed', (e: AgentStatusChangedEvent) => {
    emitter.emit('agent-status-changed', e);
  });
  conn.on('project-lifecycle-changed', (e: ProjectLifecycleChangedEvent) => {
    emitter.emit('project-lifecycle-changed', e);
  });
  conn.on('project-activity-event', (e: ProjectActivityEvent) => {
    emitter.emit('project-activity-event', e);
  });
  conn.on('project-kanban-active-count-changed', (e: ProjectKanbanActiveCountChangedEvent) => {
    emitter.emit('project-kanban-active-count-changed', e);
  });
  conn.onreconnecting(() => {
    console.log('[LifecycleHub] reconnecting');
    emitter.emit('cloud-unreachable');
  });
  conn.onreconnected(() => {
    console.log('[LifecycleHub] reconnected');
    emitter.emit('cloud-recovered');
    // NOTE: deliberately NOT re-seeding here. Instantiation (team spawn,
    // colonize) must only happen after the user clicks Start in the
    // picker — not on a background reconnect, which would spawn agents
    // while the user is still deciding / picking another project.
  });
  conn.onclose((err) => {
    console.log('[LifecycleHub] connection closed:', err?.message);
    emitter.emit('cloud-unreachable');
  });
}

/**
 * Initial-state seed. The SignalR hub is push-only; this hub (commit
 * 0e667f5) replaced the lifecycle-poller that worked in dev for months.
 * The poller did a one-shot GET current-project → GET its lifecycle and
 * emitted 'state-changed'; the hub assumed the server's snapshot-on-
 * connect would replace that, but on the prod hub no snapshot arrives
 * (Jon's log: connect, then silence) so the orchestrator never sees
 * RUNNING. This restores the poller's EXACT proven pull (deleted code at
 * 0e667f5^), once, on connect/reconnect, emitting the SAME
 * 'project-lifecycle-changed' the orchestrator already consumes. Live
 * changes still come via the SignalR push (conn.on above); this only
 * seeds the state the snapshot isn't delivering. Best-effort, never
 * throws — must not break the hub. Idempotent downstream (orchestrate
 * skips already-spawned projects; lastSeenState dedupes transitions).
 */
export async function seedInitialLifecycleState(): Promise<void> {
  try {
    // Local sidecar requires the local-secret Bearer on /v1/projects/*
    // (same as spawn-orchestrator / projectRequest). Without it the GET
    // 401s and gets swallowed as "no current project".
    const secret = getLocalSecret();
    const authHeaders: Record<string, string> = secret ? { Authorization: `Bearer ${secret}` } : {};
    const curRes = await fetch(`${ACP_API_BASE}/v1/projects/current`, { headers: authHeaders }).catch((e) => {
      console.warn('[LifecycleHub] seed /current fetch threw:', e);
      return null;
    });
    if (curRes && !curRes.ok) {
      const b = await curRes.text().catch(() => '(unreadable)');
      console.warn(`[LifecycleHub] seed /current → HTTP ${curRes.status} | secretLen=${secret ? secret.length : 'NONE'} | body=${b.slice(0, 300)}`);
    }
    const cur = curRes && curRes.ok ? await curRes.json().catch(() => null) : null;
    const curData = cur?.data ?? cur;
    const projectId: number | null =
      typeof curData?.current_project_id === 'number' ? curData.current_project_id
        : (typeof curData?.project?.id === 'number' ? curData.project.id : null);
    if (projectId === null) {
      console.log('[LifecycleHub] initial-state seed: no current project — nothing to seed');
      return;
    }
    const lcRes = await fetch(`${ACP_API_BASE}/v1/projects/${projectId}/lifecycle`, { headers: authHeaders })
      .then((r) => (r.ok ? r.json() : null)).catch(() => null);
    const lcData = lcRes?.data ?? lcRes;
    const lc = lcData?.lifecycle ?? lcData;
    const state: LifecycleState | undefined = lc?.state;
    if (!state) {
      console.log(`[LifecycleHub] initial-state seed: project=${projectId} — no lifecycle state returned`);
      return;
    }
    console.log(`[LifecycleHub] initial-state seed: project=${projectId} state=${state} — emitting project-lifecycle-changed`);
    emitter.emit('project-lifecycle-changed', {
      project_id: projectId,
      state,
      last_state_change_at: lc?.last_state_change_at ?? null,
      agents_running_count: lc?.agents_running_count ?? 0,
      agents_idle_count: lc?.agents_idle_count ?? 0,
    } as ProjectLifecycleChangedEvent);
  } catch (err) {
    console.warn('[LifecycleHub] initial-state seed failed (non-fatal):', err);
  }
}

export async function startLifecycleHub(): Promise<void> {
  if (started) return;
  started = true;
  try {
    connection = await buildConnection();
    setupHandlers(connection);
    await connection.start();
    console.log('[LifecycleHub] connected to', HUB_URL);
    emitter.emit('cloud-recovered'); // initial-connect = recovered
    // NO auto-seed on connect. The hub connects at boot (so live state
    // pushes work later), but team instantiation (spawn + colonize +
    // mail) must be GATED on the user's explicit Start click in the
    // picker — which calls reseedLifecycle → seedInitialLifecycleState.
    // Auto-seeding here spawned the whole team (token spend) before the
    // user confirmed the project / while they could still "Pick another".
  } catch (err) {
    console.warn('[LifecycleHub] initial connect failed:', err);
    emitter.emit('cloud-unreachable');
    started = false;
  }
}

export async function stopLifecycleHub(): Promise<void> {
  started = false;
  if (connection) {
    try { await connection.stop(); } catch { /* ignore */ }
    connection = null;
  }
  console.log('[LifecycleHub] stopped');
}

export type LifecycleHubEvent =
  | 'agent-status-changed'
  | 'project-lifecycle-changed'
  | 'project-activity-event'
  | 'project-kanban-active-count-changed'
  | 'cloud-unreachable'
  | 'cloud-recovered';

export function onLifecycleHubEvent(
  event: LifecycleHubEvent,
  listener: (...args: unknown[]) => void,
): () => void {
  emitter.on(event, listener);
  return () => emitter.off(event, listener);
}
