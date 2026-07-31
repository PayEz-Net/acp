/**
 * PayEzVibe agent session lifecycle manager.
 *
 * Maintains a server-side `agent_sessions` record for each spawned agent while
 * it is running. Started sessions receive periodic heartbeats so the backend
 * does not mark them inactive; sessions are ended when the agent is killed,
 * exits, or the project lifecycle tears down.
 *
 * Calls are routed through the local acp-api sidecar so the desktop does not
 * need to manage IDP bearer tokens or project_id injection. The sidecar reads
 * the active project from its cache and forwards to the cloud.
 *
 * The module keeps its own state keyed by terminal/runtime id so it can be
 * driven from both the PTY path and the ACP runtime path without leaking
 * lifecycle details into those modules.
 */

const ACP_API_URL = process.env.ACP_API_URL || 'http://127.0.0.1:3001';

export interface AgentSession {
  /** PayEzVibe agent session id. */
  id: string;
  /** Backend-issued opaque session token. */
  sessionToken: string;
  /** Numeric agent id from `team_agent_instances.agent_id` (the engaged
   *  standing team's instance — live-team model). */
  agentId: number;
}

export type AgentSessionEndReason = 'normal' | 'killed' | 'teardown' | 'takeover';

export type AgentSessionStartResult =
  | { ok: true; session: AgentSession }
  | { ok: false; status?: number; message: string };

interface SessionState {
  terminalId: string;
  agentId: number;
  session: AgentSession | null;
  heartbeatTimer: NodeJS.Timeout | null;
  status: 'starting' | 'active' | 'ending' | 'ended';
  pendingEndReason?: AgentSessionEndReason;
  /** Guards against overlapping re-register attempts after a heartbeat 404. */
  reregistering: boolean;
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
  _projectId?: number,
): Promise<AgentSessionStartResult> {
  if (sessions.has(terminalId)) {
    console.warn(
      `[AgentSession] session already tracked for terminal=${terminalId}; ignoring duplicate start`,
    );
    return { ok: true, session: sessions.get(terminalId)!.session! };
  }

  const state: SessionState = {
    terminalId,
    agentId,
    session: null,
    heartbeatTimer: null,
    status: 'starting',
    reregistering: false,
  };
  sessions.set(terminalId, state);

  try {
    const session = await sendStart(agentId);
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
      `/v1/agent-sessions/${state.session.id}/heartbeat`,
      'POST',
    );

    if (res.status === 401 || res.status === 403) {
      console.warn(
        `[AgentSession] heartbeat auth failed for session=${state.session.id}; stopping heartbeat`,
      );
      stopHeartbeat(state);
      return;
    }

    if (res.status === 404) {
      // The backend no longer holds this session (inactivity expiry or a
      // transient backend blip — observed 404ing for ~a minute, then
      // recovering). Every further heartbeat 404s until a runtime restart
      // happens to re-register, and the agent's own mail calls fail with
      // SESSION_INACTIVE in the meantime — agents read that as "I am
      // deactivated" and go silent. Re-register immediately instead.
      console.warn(
        `[AgentSession] heartbeat 404 for session=${state.session.id}; re-registering a fresh session`,
      );
      await reregisterSession(state);
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

/**
 * Re-register the agent session after a heartbeat 404. Starts a fresh
 * backend session and swaps it into the tracked state so subsequent
 * heartbeats (and the backend's reachability view of the agent) recover on
 * the next tick instead of waiting for a runtime restart.
 */
async function reregisterSession(state: SessionState): Promise<void> {
  if (state.reregistering) return;
  state.reregistering = true;
  try {
    const previousId = state.session?.id;
    const session = await sendStart(state.agentId);
    if (state.status !== 'active') {
      // The session was ended while the start was in flight — don't leak the
      // fresh record on the backend.
      await sendEnd(session.id, 'normal').catch(() => {});
      return;
    }
    state.session = session;
    console.log(
      `[AgentSession] re-registered session=${session.id} (was ${previousId}) for terminal=${state.terminalId} agent=${state.agentId}`,
    );
  } catch (err) {
    console.warn(
      `[AgentSession] re-register failed for terminal=${state.terminalId}; retrying on next heartbeat:`,
      err,
    );
  } finally {
    state.reregistering = false;
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

async function sendStart(agentId: number): Promise<AgentSession> {
  const res = await fetchSessionEndpoint('/v1/agent-sessions/start', 'POST', { agent_id: agentId });

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
    `/v1/agent-sessions/${sessionId}/end?reason=${encodeURIComponent(reason)}`,
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
  const init: RequestInit = { method };
  const headers: Record<string, string> = {};
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  init.headers = headers;
  return fetch(`${ACP_API_URL}${path}`, init);
}

function extractSession(json: Record<string, unknown>): Record<string, unknown> | null {
  const data = (json.data ?? json) as Record<string, unknown> | undefined;
  if (!data) return null;
  const session = (data.session ?? data) as Record<string, unknown> | undefined;
  return session ?? null;
}
