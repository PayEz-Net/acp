/**
 * STARTED PROJECT — declaring the dev's chosen project to the acp-api sidecar.
 *
 * THE RULE (Jon, 2026-08-01):
 *   The current project is the project the dev clicked START on, ON THIS MACHINE.
 *   That is the only evidence. There is no other factor.
 *
 * Electron owns the durable value (electron-store, see store.ts). This module
 * pushes it into the sidecar, which holds it in memory and serves it from
 * `GET /v1/projects/current` in preference to ANY cloud or cache value.
 *
 * It is declared twice, deliberately:
 *   1. on every Start/switch — the click itself
 *   2. on every boot — replayed from electron-store, so a restart comes back on
 *      the project the dev chose rather than on whatever the shared cloud slot says
 *
 * WHY NOT LET THE CLOUD DECIDE
 * `/v1/users/me/current-project` is a SINGLE PER-USER SLOT SHARED ACROSS MACHINES.
 * `agentSessionLifecycle.ts` documents this and refuses to use it. On 2026-07-31/08-01
 * one account driving project 31 (Windows) and 18 (Mac) produced: two agents with
 * empty inboxes for a full night (unreachable, every send AGENT_NOT_FOUND), a sprint's
 * mail filed into the other project, another team ~40 turns behind on traffic that was
 * never theirs, and a cold restart landing on the wrong project.
 *
 * FAILURE POLICY — NO SILENT FALLBACK
 * If the declaration cannot be delivered, we LOG LOUDLY and report failure. We do not
 * retry into a guess and we do not let the caller assume it worked. A sidecar that
 * never received a declaration serves `null` — "no project engaged" — which is the
 * correct, visible outcome. A wrong project is far worse than a missing one.
 */

import { getLocalSecret } from './api-server';
import { getStartedProject, setStartedProject, type StartedProject } from './store';

const ACP_API_BASE = process.env.ACP_API_URL || 'http://127.0.0.1:3001';

export interface DeclareResult {
  success: boolean;
  errorMessage?: string;
}

/** POST the declaration to the sidecar. Pure transport — no persistence here. */
async function pushToSidecar(entry: StartedProject): Promise<DeclareResult> {
  try {
    const secret = getLocalSecret();
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (secret) headers['Authorization'] = `Bearer ${secret}`;

    const res = await fetch(`${ACP_API_BASE}/internal/project/started`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        project_id: entry.project_id,
        project_name: entry.project_name,
        user_id: entry.user_id,
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '(unreadable)');
      const msg = `sidecar returned HTTP ${res.status}: ${body.slice(0, 200)}`;
      console.error(`[StartedProject] DECLARATION FAILED — ${msg}`);
      return { success: false, errorMessage: msg };
    }
    console.log(
      `[StartedProject] declared to sidecar: ${entry.project_id}` +
        ` (${entry.project_name ?? 'unnamed'}) user=${entry.user_id}`,
    );
    return { success: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'unknown error';
    console.error(`[StartedProject] DECLARATION FAILED — sidecar unreachable: ${msg}`);
    return { success: false, errorMessage: msg };
  }
}

/**
 * The dev clicked Start. Persist the choice machine-locally, then declare it.
 *
 * Persistence happens FIRST and unconditionally: if the sidecar is briefly down,
 * the dev's choice still survives and is replayed on the next boot. Losing the
 * declaration because a transport failed would reintroduce exactly the drift
 * this exists to prevent.
 */
export async function declareStartedProject(
  projectId: number,
  projectName: string | null,
  userId: string = '',
): Promise<DeclareResult> {
  // user_id is advisory: the sidecar resolves identity from its own authenticated
  // session and that wins. Passing it here only helps diagnostics.
  const entry: StartedProject = {
    project_id: projectId,
    project_name: projectName,
    user_id: userId,
    started_at: new Date().toISOString(),
  };
  setStartedProject(entry);
  return pushToSidecar(entry);
}

/**
 * Replay the stored declaration on boot.
 *
 * Without this the sidecar starts empty and `GET /v1/projects/current` falls
 * through to the cloud — the shared per-user slot — which is how a restart
 * previously came back on another machine's project.
 *
 * Absent declaration is NOT an error: a dev who has never clicked Start has no
 * project engaged, and the picker should say so rather than pick one.
 */
export async function replayStartedProjectOnBoot(): Promise<void> {
  const stored = getStartedProject();
  if (!stored) {
    console.log('[StartedProject] boot: nothing declared on this machine — no project engaged');
    return;
  }
  const result = await pushToSidecar(stored);
  if (!result.success) {
    console.error(
      '[StartedProject] boot replay FAILED — the sidecar will report no project engaged.' +
        ' Mail and agent routing will refuse rather than guess. Re-click Start to recover.',
    );
  }
}
