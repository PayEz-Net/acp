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
 * Sessions are deduplicated by agent_id. The cloud's StartSession ends any
 * existing active session for the same user+agent, so multiple terminals/runtimes
 * for the same agent must share one cloud session or they will fight and 404 each
 * other's heartbeats.
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

interface AgentSessionEntry {
  agentId: number;
  session: AgentSession;
  /** Terminal/runtime ids that are using this agent session. */
  refs: Set<string>;
  heartbeatTimer: NodeJS.Timeout | null;
  status: 'active' | 'ending' | 'ended';
  /** Guards against overlapping re-register attempts after a heartbeat 404. */
  reregistering: boolean;
  /** Promise for an in-flight start so concurrent starts for the same agent
   *  share the result instead of racing. */
  startPromise?: Promise<AgentSessionStartResult>;
  /** End reason queued while the session was still starting. */
  pendingEndReason?: AgentSessionEndReason;
}

// Active cloud sessions keyed by agent_id. Multiple terminals for the same
// agent share one entry.
const agentSessions = new Map<number, AgentSessionEntry>();

// Reverse lookup: terminal -> agent. Used by endAgentSession to find the entry.
const terminalToAgent = new Map<string, number>();

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
  if (terminalToAgent.has(terminalId)) {
    const existingAgentId = terminalToAgent.get(terminalId)!;
    const existingEntry = agentSessions.get(existingAgentId);
    console.warn(
      `[AgentSession] terminal=${terminalId} already mapped to agent=${existingAgentId}; ignoring duplicate start`,
    );
    return existingEntry
      ? { ok: true, session: existingEntry.session }
      : { ok: false, message: 'Terminal mapped to a session that is no longer tracked' };
  }

  const existingEntry = agentSessions.get(agentId);
  if (existingEntry) {
    // Share the existing cloud session. If it's still starting, wait for it.
    if (existingEntry.startPromise) {
      const result = await existingEntry.startPromise;
      if (result.ok) {
        existingEntry.refs.add(terminalId);
        terminalToAgent.set(terminalId, agentId);
      }
      return result;
    }
    existingEntry.refs.add(terminalId);
    terminalToAgent.set(terminalId, agentId);
    console.log(
      `[AgentSession] reusing session=${existingEntry.session.id} for terminal=${terminalId} agent=${agentId}`,
    );
    return { ok: true, session: existingEntry.session };
  }

  const entry: AgentSessionEntry = {
    agentId,
    session: null as any, // set before promise resolves externally
    refs: new Set([terminalId]),
    heartbeatTimer: null,
    status: 'active',
    reregistering: false,
  };
  agentSessions.set(agentId, entry);
  terminalToAgent.set(terminalId, agentId);

  const startPromise = (async (): Promise<AgentSessionStartResult> => {
    try {
      const session = await sendStart(agentId);
      entry.session = session;
      delete entry.startPromise;
      console.log(
        `[AgentSession] started session=${session.id} for terminal=${terminalId} agent=${agentId}`,
      );
      startHeartbeat(entry);

      // If an end was requested while we were starting, honor it now.
      if (entry.pendingEndReason) {
        const reason = entry.pendingEndReason;
        delete entry.pendingEndReason;
        void endAgentForAgent(agentId, reason);
      }

      return { ok: true, session };
    } catch (err) {
      const status = err instanceof StartError ? err.status : undefined;
      const message = err instanceof Error ? err.message : String(err);
      console.warn(
        `[AgentSession] failed to start session for terminal=${terminalId} agent=${agentId}:`,
        err,
      );
      entry.status = 'ended';
      agentSessions.delete(agentId);
      terminalToAgent.delete(terminalId);
      return { ok: false, status, message };
    }
  })();

  entry.startPromise = startPromise;
  return startPromise;
}

/**
 * End the PayEzVibe agent session for the given terminal/runtime.
 *
 * Idempotent: subsequent calls are ignored once a session is ending/ended or
 * after the terminal id is no longer tracked. The cloud session is only ended
 * when the last terminal for that agent goes away.
 */
export async function endAgentSession(
  terminalId: string,
  reason: AgentSessionEndReason = 'normal',
): Promise<void> {
  const agentId = terminalToAgent.get(terminalId);
  if (agentId === undefined) return;
  terminalToAgent.delete(terminalId);

  const entry = agentSessions.get(agentId);
  if (!entry) return;

  entry.refs.delete(terminalId);

  // If still starting, queue the end. The first caller wins.
  if (entry.startPromise) {
    if (!entry.pendingEndReason) {
      entry.pendingEndReason = reason;
    }
    return;
  }

  if (entry.status === 'ending' || entry.status === 'ended') return;

  // Only end the cloud session when the last terminal drops.
  if (entry.refs.size === 0) {
    await endAgentForAgent(agentId, reason);
  }
}

async function endAgentForAgent(agentId: number, reason: AgentSessionEndReason): Promise<void> {
  const entry = agentSessions.get(agentId);
  if (!entry) return;
  if (entry.status === 'ending' || entry.status === 'ended') return;

  entry.status = 'ending';
  stopHeartbeat(entry);

  try {
    await sendEnd(entry.session.id, reason);
    console.log(
      `[AgentSession] ended session=${entry.session.id} reason=${reason} agent=${agentId}`,
    );
  } catch (err) {
    console.warn(
      `[AgentSession] failed to end session=${entry.session.id} reason=${reason} agent=${agentId}:`,
      err,
    );
  }

  entry.status = 'ended';
  agentSessions.delete(agentId);
}

/**
 * Return the active PayEzVibe session for a terminal, if any.
 */
export function getAgentSession(terminalId: string): AgentSession | null {
  const agentId = terminalToAgent.get(terminalId);
  if (agentId === undefined) return null;
  const entry = agentSessions.get(agentId);
  return entry?.session ?? null;
}

function startHeartbeat(entry: AgentSessionEntry): void {
  if (entry.heartbeatTimer) {
    clearInterval(entry.heartbeatTimer);
  }
  entry.heartbeatTimer = setInterval(() => {
    void heartbeat(entry);
  }, HEARTBEAT_INTERVAL_MS);
}

function stopHeartbeat(entry: AgentSessionEntry): void {
  if (entry.heartbeatTimer) {
    clearInterval(entry.heartbeatTimer);
    entry.heartbeatTimer = null;
  }
}

async function heartbeat(entry: AgentSessionEntry): Promise<void> {
  if (entry.status !== 'active') return;

  try {
    const res = await fetchSessionEndpoint(
      `/v1/agent-sessions/${entry.session.id}/heartbeat`,
      'POST',
    );

    if (res.status === 401 || res.status === 403) {
      console.warn(
        `[AgentSession] heartbeat auth failed for session=${entry.session.id}; stopping heartbeat`,
      );
      stopHeartbeat(entry);
      return;
    }

    if (res.status === 404) {
      console.warn(
        `[AgentSession] heartbeat 404 for session=${entry.session.id}; re-registering a fresh session`,
      );
      await reregisterSession(entry);
      return;
    }

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.warn(
        `[AgentSession] heartbeat failed for session=${entry.session.id}: HTTP ${res.status} ${body.slice(0, 200)}`,
      );
    }
  } catch (err) {
    console.warn(
      `[AgentSession] heartbeat exception for session=${entry.session.id}:`,
      err,
    );
  }
}

/**
 * Re-register the agent session after a heartbeat 404. Starts a fresh
 * backend session and swaps it into the shared entry so subsequent
 * heartbeats recover on the next tick.
 */
async function reregisterSession(entry: AgentSessionEntry): Promise<void> {
  if (entry.reregistering) return;
  entry.reregistering = true;
  try {
    const previousId = entry.session.id;
    const session = await sendStart(entry.agentId);
    if (entry.status !== 'active') {
      // The session was ended while the start was in flight — clean up.
      await sendEnd(session.id, 'normal').catch(() => {});
      return;
    }
    entry.session = session;
    console.log(
      `[AgentSession] re-registered session=${session.id} (was ${previousId}) agent=${entry.agentId}`,
    );
  } catch (err) {
    console.warn(
      `[AgentSession] re-register failed for agent=${entry.agentId}; retrying on next heartbeat:`,
      err,
    );
  } finally {
    entry.reregistering = false;
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
