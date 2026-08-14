/**
 * The project the developer clicked Start on.
 *
 * This is the only source of truth for "what project is this rig on".
 * Not the cloud — it cannot know. Not a cache. Not the picker's default row.
 *
 * Set by a Start click. Changed only by a Start click on a different project.
 */

let startedProjectId: number | null = null;
let startedProjectName: string | null = null;

export function setStartedProject(projectId: number, projectName: string | null): void {
  startedProjectId = projectId;
  startedProjectName = projectName;
  console.log(`[StartedProject] ${projectId} (${projectName ?? 'unnamed'})`);
}

/** The started project, or null when the developer has not clicked Start yet. */
export function getStartedProjectId(): number | null {
  return startedProjectId;
}

/**
 * Thrown when work that belongs to a project is attempted before Start was clicked.
 *
 * There is no answer to "which project" in that state, so there is no work to do.
 * Guessing one — from the cloud, a cache, or by omitting the filter and letting the
 * server pick — is what routes a team's mail into somebody else's project.
 */
export class ProjectNotEngagedError extends Error {
  readonly code = 'PROJECT_NOT_ENGAGED';
  readonly status = 409;
  constructor(what: string) {
    super(`${what} requires an engaged project — click Start on a project first`);
    this.name = 'ProjectNotEngagedError';
  }
}

/** The started project, or a refusal. Use this anywhere a project is required. */
export function requireStartedProjectId(what: string): number {
  if (startedProjectId === null) throw new ProjectNotEngagedError(what);
  return startedProjectId;
}

export function getStartedProjectName(): string | null {
  return startedProjectName;
}
