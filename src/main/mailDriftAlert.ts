/**
 * 209637: the current-project drift alert, delivered.
 *
 * The acp-api sidecar detects drift at the mail stamp point (139077) and
 * stamps it onto inbox responses as `data.platform_alert` for a window.
 * This module is the pure, testable half of the delivery: extraction, the
 * dedupe key, and the notice text the pty poller injects into the agent's
 * pane — the surface headless agents actually read. (The console.error in
 * the sidecar only reaches a log file.)
 */

export interface DriftAlert {
  type: string;
  from: number | null;
  to: number | null;
  detected_at?: string;
  message?: string;
}

/** Pull the drift alert out of an inbox response body, or null. */
export function extractDriftAlert(response: any): DriftAlert | null {
  const a = response?.data?.platform_alert;
  if (!a || typeof a !== 'object') return null;
  if (a.type !== 'CURRENT_PROJECT_DRIFT') return null;
  return a as DriftAlert;
}

/** One injection per drift per poller — keyed on the transition, not the clock. */
export function driftAlertKey(a: DriftAlert): string {
  return `${a.from}->${a.to}`;
}

export function formatDriftAlertNotice(a: DriftAlert): string {
  return (
    `[ACP Platform] CURRENT-PROJECT DRIFT: mail now resolves against project ${a.to}'s team (was ${a.from}). ` +
    `'Not found' errors on known agents are the drift, not deregistration — verify the current-project ` +
    `setting before acting on them (139077/209637).`
  );
}
