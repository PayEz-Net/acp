/**
 * PayEzVibe agent session lifecycle manager.
 *
 * Maintains a server-side `agent_sessions` record for each spawned agent while
 * it is running. Started sessions receive periodic heartbeats so the backend
 * does not mark them inactive; sessions are ended when the agent is killed,
 * exits, or the project lifecycle tears down.
 *
 * The module keeps its own state keyed by terminal/runtime id so it can be
 * driven from both the PTY path and the ACP runtime path without leaking
 * lifecycle details into those modules.
 */

import { VIBE_API_URL } from './env';
import { buildVsqlCacheAuthHeaders, hasCapability } from './vsql-cache-client';

export interface AgentSession {
  /** PayEzVibe agent session id. */
  id: string;
  /** Backend-issued opaque session token. */
  sessionToken: string;
  /** Numeric agent id from `project_team_members.agent_id`. */
  agentId: number;
}

export type AgentSessionEndReason = 'normal' | 'killed' | 'teardown' | 'takeover';

export type AgentSessionStartResult =
  | { ok: true; session: AgentSession }
  | { ok: false; status?: number; message: string };

interface SessionState {
  terminalId: string;
  agentId: number;
  projectId?: number;
  session: AgentSession | null;
  heartbeatTimer: NodeJS.Timeout | null;
  status: 'starting' | 'active' | 'ending' | 'ended';
  pendingEndReason?: AgentSessionEndReason;
}

const sessions = new Map<string, SessionState>();

// Backend inactivity cutoff is ~5 minutes. 30s keeps us well under it while
// not spamming the API.
const HEARTBEAT_INTERVAL_MS = 30_000;

/**
 * Start a PayEzVibe agent session for the given terminal/runtime.
 *
 * A session start failure is non-fatal: it returns an `{ ok: false, ... }`
 * result so the caller can surface the error in the UI without blocking the
 * underlying spawn.
 */
export async function startAgentSession(
  terminalId: string,
  agentId: number,
  projectId?: number,
): Promise<AgentSessionStartResult> {
  if (!(await hasCapability('agent_terminal_output'))) {
    return {
      ok: false,
      status: 403,
      message: 'Agent session could not be started. Missing capability: agent_terminal_output.',
    };
  }

  if (sessions.has(terminalId)) {
    console.warn(
      `[AgentSession] session already tracked for terminal=${terminalId}; ignoring duplicate start`,
    );
    return { ok: true, session: sessions.get(terminalId)!.session! };
  }

  const state: SessionState = {
    terminalId,
    agentId,
    projectId,
    session: null,
    heartbeatTimer: null,
    status: 'starting',
  };
  sessions.set(terminalId, state);

  try {
    const session = await sendStart(agentId, projectId);
    state.session = session;
    state.status = 'active';
    console.log(
      `[AgentSession] started session=${session.id} for terminal=${terminalId} agent=${agentId}`,
    );
    startHeartbeat(state);

    // If an end was requested while we were still starting, honor it now.
    if (state.pendingEndReason) {
      void endAgentSession(terminalId, state.pendingEndReason);
    }

    return { ok: true, session };
  } catch (err) {
    const status = err instanceof StartError ? err.status : undefined;
    const message = err instanceof Error ? err.message : String(err);
    console.warn(
      `[AgentSession] failed to start session for terminal=${terminalId} agent=${agentId}:`,
      err,
    );
    state.status = 'ended';
    sessions.delete(terminalId);
    return { ok: false, status, message };
  }
}

/**
 * End the PayEzVibe agent session for the given terminal/runtime.
 *
 * Idempotent: subsequent calls are ignored once a session is ending/ended or
 * after the terminal id is no longer tracked.
 */
export async function endAgentSession(
  terminalId: string,
  reason: AgentSessionEndReason = 'normal',
): Promise<void> {
  const state = sessions.get(terminalId);
  if (!state) return;

  if (state.status === 'ending' || state.status === 'ended') return;

  // If start hasn't completed yet, queue the end reason. The first caller wins
  // so lifecycle teardown doesn't get overwritten by a later user kill.
  if (state.status === 'starting') {
    if (!state.pendingEndReason) {
      state.pendingEndReason = reason;
    }
    return;
  }

  state.status = 'ending';
  stopHeartbeat(state);

  const session = state.session;
  if (session) {
    try {
      await sendEnd(session.id, reason);
      console.log(
        `[AgentSession] ended session=${session.id} reason=${reason} terminal=${terminalId}`,
      );
    } catch (err) {
      console.warn(
        `[AgentSession] failed to end session=${session.id} reason=${reason} terminal=${terminalId}:`,
        err,
      );
    }
  }

  state.status = 'ended';
  sessions.delete(terminalId);
}

/**
 * Return the active PayEzVibe session for a terminal, if any.
 */
export function getAgentSession(terminalId: string): AgentSession | null {
  const state = sessions.get(terminalId);
  return state?.session ?? null;
}

function startHeartbeat(state: SessionState): void {
  if (state.heartbeatTimer) {
    clearInterval(state.heartbeatTimer);
  }
  state.heartbeatTimer = setInterval(() => {
    void heartbeat(state);
  }, HEARTBEAT_INTERVAL_MS);
}

function stopHeartbeat(state: SessionState): void {
  if (state.heartbeatTimer) {
    clearInterval(state.heartbeatTimer);
    state.heartbeatTimer = null;
  }
}

async function heartbeat(state: SessionState): Promise<void> {
  if (!state.session || state.status !== 'active') return;

  try {
    const res = await fetchSessionEndpoint(
      `/v1/sessions/${state.session.id}/heartbeat`,
      'POST',
    );

    if (res.status === 401 || res.status === 403) {
      console.warn(
        `[AgentSession] heartbeat auth failed for session=${state.session.id}; stopping heartbeat`,
      );
      stopHeartbeat(state);
      return;
    }

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.warn(
        `[AgentSession] heartbeat failed for session=${state.session.id}: HTTP ${res.status} ${body.slice(0, 200)}`,
      );
    }
  } catch (err) {
    console.warn(
      `[AgentSession] heartbeat exception for session=${state.session.id}:`,
      err,
    );
  }
}

class StartError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = 'StartError';
  }
}

function formatStartError(status: number, body: string): StartError {
  if (status === 403) {
    return new StartError(
      'Agent session could not be started. Missing capability: agent_mail.',
      status,
    );
  }
  return new StartError(`Agent session could not be started. Server returned HTTP ${status}.`, status);
}

async function sendStart(agentId: number, projectId?: number): Promise<AgentSession> {
  const body: Record<string, unknown> = { agent_id: agentId };
  if (projectId !== undefined) {
    body.project_id = projectId;
  }
  const res = await fetchSessionEndpoint('/v1/sessions/start', 'POST', body);

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw formatStartError(res.status, body.slice(0, 200));
  }

  const json = (await res.json()) as Record<string, unknown>;
  const session = extractSession(json);
  if (!session || !session.id) {
    throw new Error('start response did not contain session.id');
  }

  return {
    id: String(session.id),
    sessionToken: String(session.session_token ?? ''),
    agentId,
  };
}

async function sendEnd(sessionId: string, reason: AgentSessionEndReason): Promise<void> {
  const res = await fetchSessionEndpoint(
    `/v1/sessions/${sessionId}/end?reason=${encodeURIComponent(reason)}`,
    'POST',
  );

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status}: ${body.slice(0, 200)}`);
  }
}

async function fetchSessionEndpoint(
  path: string,
  method: 'POST',
  body?: unknown,
): Promise<Response> {
  const headers = await buildVsqlCacheAuthHeaders(method, path);
  const init: RequestInit = {
    method,
    headers,
  };
  if (body !== undefined) {
    (init.headers as Record<string, string>)['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  return fetch(`${VIBE_API_URL}${path}`, init);
}

function extractSession(json: Record<string, unknown>): Record<string, unknown> | null {
  const data = (json.data ?? json) as Record<string, unknown> | undefined;
  if (!data) return null;
  const session = (data.session ?? data) as Record<string, unknown> | undefined;
  return session ?? null;
}
