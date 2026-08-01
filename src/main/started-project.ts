/**
 * STARTED PROJECT — the dev clicked Start on a project. That is the whole feature.
 *
 * THE RULE (Jon, 2026-08-01):
 *   A click returns an integer value as selected. Set it globally in the -api.
 *   Never let it be written again unless Start is clicked on a different project.
 *
 * There is no cloud authority here. The cloud cannot know which project a
 * developer wants to work on; `/v1/users/me/current-project` is a UI convenience
 * describing which row to show top-and-front in the picker, and nothing more.
 * Worse, it is a SINGLE PER-USER SLOT SHARED ACROSS MACHINES, so a second rig
 * clicking Start on a different project silently reassigns this one.
 *
 * NOT PERSISTED, DELIBERATELY.
 * A fresh boot has no project engaged, because the dev has not clicked anything
 * yet. Replaying a previous session's choice would assert a Start that did not
 * happen — the same sin as reading the cloud, just with a friendlier source.
 * The picker exists for exactly that state.
 */

import { getLocalSecret } from './api-server';

const ACP_API_BASE = process.env.ACP_API_URL || 'http://127.0.0.1:3001';

export interface DeclareResult {
  success: boolean;
  errorMessage?: string;
}

/**
 * The dev clicked Start. Send the integer to the sidecar, which holds it as the
 * one global answer to "what project is this rig on".
 *
 * Failure is LOUD and reported. No retry into a guess, no silent success.
 */
export async function declareStartedProject(
  projectId: number,
  projectName: string | null,
): Promise<DeclareResult> {
  try {
    const secret = getLocalSecret();
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (secret) headers['Authorization'] = `Bearer ${secret}`;

    const res = await fetch(`${ACP_API_BASE}/internal/project/started`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ project_id: projectId, project_name: projectName }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '(unreadable)');
      const msg = `sidecar returned HTTP ${res.status}: ${body.slice(0, 200)}`;
      console.error(`[StartedProject] DECLARATION FAILED — ${msg}`);
      return { success: false, errorMessage: msg };
    }
    console.log(`[StartedProject] declared: ${projectId} (${projectName ?? 'unnamed'})`);
    return { success: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'unknown error';
    console.error(`[StartedProject] DECLARATION FAILED — sidecar unreachable: ${msg}`);
    return { success: false, errorMessage: msg };
  }
}
