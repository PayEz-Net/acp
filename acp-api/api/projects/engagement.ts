/**
 * Process-local "the user clicked Start on THIS project" authority.
 *
 * The cloud-stored current-project pointer is a single per-user slot shared
 * by every machine on the account. It is hydrated at boot for picker display
 * ONLY — the backend is not the boss of what this machine's current project
 * is. The ONLY legitimate authority is the user's explicit Start: the main
 * process tells the sidecar the project via POST /v1/projects/engaged
 * { project_id }, fired from the LIFECYCLE_RESEED IPC handler — the one wire
 * every ProjectPicker Start branch shares.
 *
 * Anything that ACTS on a project (mail routing, roster resolution) must
 * scope from getEngagedProjectId() and refuse when it is null — never fall
 * back to the cloud-hydrated cache. That fallback is exactly the
 * stored-vs-engaged confusion this module exists to kill.
 *
 * Process-local by design: project switches relaunch the app
 * (project-switch.ts), so the value naturally resets per session. Never
 * persist it. Never hydrate it from the cloud.
 */
let engagedProjectId: number | null = null;

export function getEngagedProjectId(): number | null {
  return engagedProjectId;
}

export function isProjectEngaged(): boolean {
  return engagedProjectId != null;
}

export function markProjectEngaged(projectId: number): void {
  engagedProjectId = projectId;
}

export class ProjectNotEngagedError extends Error {
  constructor() {
    super(
      'No project engaged — select a project and click Start before project-scoped operations run',
    );
    this.name = 'ProjectNotEngagedError';
  }
}
