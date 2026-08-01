/**
 * STARTED PROJECT — the machine-local, dev-declared current project.
 *
 * THE RULE (Jon, 2026-08-01):
 *   The current project is the project the dev clicked START on, ON THIS MACHINE.
 *   That is the only evidence. There is no other factor.
 *
 *     NOT hydrated from the cloud — the cloud cannot know what a dev wants to work on.
 *     NOT a per-user slot shared across machines.
 *     NOT the picker's default row.
 *     NOT a cached value, fresh or stale.
 *
 * WHY THIS EXISTS
 * `/v1/users/me/current-project` is a SINGLE PER-USER SLOT SHARED ACROSS MACHINES.
 * `agentSessionLifecycle.ts` already documents the consequence and deliberately
 * refuses to use it:
 *
 *   "one account on two machines with two projects would otherwise stamp both
 *    sessions with whichever machine wrote that slot last."
 *
 * Mail routing and the current-project pointer never adopted that lesson. On
 * 2026-07-31/08-01, one account driving project 31 (Windows) and project 18 (Mac)
 * produced, all measured:
 *
 *   - two agents (DotNetPert-Scout, ScribePert) with EMPTY inboxes for a full night:
 *     they are on project 31 only, and while the shared slot read 18 they were
 *     unreachable by ANYONE. Every send to them returned AGENT_NOT_FOUND.
 *   - IDP-sprint mail filed into the SEO project's history.
 *   - the other project's team ~40 turns behind, processing traffic never meant for them.
 *   - a cold ACP restart coming back on the WRONG project, because boot re-read the slot.
 *
 * OWNERSHIP OF TRUTH
 * Electron owns persistence (electron-store, machine-local). It pushes the value
 * here on every Start/switch and again on every boot. This module is the sidecar's
 * copy of that declaration. The sidecar never derives it, never refreshes it from
 * the cloud, and never falls back to a cache when it is set.
 *
 * DELIBERATELY NO FALLBACK
 * If nothing has been declared, callers get `null` and must treat that as
 * "no project engaged" — NOT as licence to guess. A missing value is a finding.
 */

export interface StartedProject {
  /** Project the dev clicked Start on. */
  projectId: number;
  /** Display name at the time Start was clicked (for logs/diagnostics only). */
  projectName: string | null;
  /** The dev user this declaration belongs to. */
  userId: string;
  /** ISO timestamp of the Start click. */
  startedAt: string;
}

let declared: StartedProject | null = null;

/**
 * Record the dev's Start click. Called by Electron via POST /internal/project/started.
 * Overwrites any previous declaration — clicking Start on a different project is
 * exactly how this value is meant to change, and the ONLY way.
 */
export function setStartedProject(entry: StartedProject): StartedProject {
  const prev = declared;
  declared = entry;
  if (prev && prev.projectId !== entry.projectId) {
    console.log(
      `[StartedProject] dev switched project: ${prev.projectId} -> ${entry.projectId}` +
        ` (${entry.projectName ?? 'unnamed'}) user=${entry.userId}`,
    );
  } else if (!prev) {
    console.log(
      `[StartedProject] declared: ${entry.projectId} (${entry.projectName ?? 'unnamed'})` +
        ` user=${entry.userId} at ${entry.startedAt}`,
    );
  }
  return declared;
}

/**
 * The declared project for this user, or null.
 *
 * Returns null — never a guess — when:
 *   - nothing has been declared yet (no Start click since boot), or
 *   - the declaration belongs to a different user than the one asking.
 *
 * A null here means "no project engaged". Callers must surface that, not paper over it.
 */
export function getStartedProject(userId: string): StartedProject | null {
  if (!declared) return null;
  if (declared.userId !== userId) {
    console.warn(
      `[StartedProject] declaration is for user ${declared.userId}, request is for ${userId}` +
        ' — refusing to serve another user\'s project',
    );
    return null;
  }
  return declared;
}

/** Raw declaration regardless of user — diagnostics only. */
export function peekStartedProject(): StartedProject | null {
  return declared;
}

/** Clear the declaration. Used on sign-out; NOT part of normal operation. */
export function clearStartedProject(): void {
  if (declared) console.log(`[StartedProject] cleared (was ${declared.projectId})`);
  declared = null;
}
