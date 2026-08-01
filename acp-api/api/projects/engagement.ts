/**
 * Compat shim over ./startedProject.js — introduced by the turn-stack-defense
 * merge (2026-08-01). Both branches built a process-local "the user clicked
 * Start on THIS project" authority: this module (engagement, fed by POST
 * /v1/projects/engaged) and startedProject.ts (fed by POST
 * /internal/project/started). They are the SAME authority; startedProject.ts
 * is the single state holder (it also tracks the project name and carries the
 * coded 409 error). Everything here delegates to it so both write paths land
 * in one place.
 *
 * The cloud-stored current-project pointer is a single per-user slot shared
 * by every machine on the account — it is picker display state, never an
 * authority. The ONLY legitimate authority is the user's explicit Start.
 * Process-local by design: project switches relaunch the app, so the value
 * naturally resets per session. Never persist it. Never hydrate it from the
 * cloud.
 */
import {
  getStartedProjectId,
  setStartedProject,
  ProjectNotEngagedError,
} from './startedProject.js';

export function getEngagedProjectId(): number | null {
  return getStartedProjectId();
}

export function isProjectEngaged(): boolean {
  return getStartedProjectId() != null;
}

export function markProjectEngaged(projectId: number): void {
  setStartedProject(projectId, null);
}

export { ProjectNotEngagedError };
