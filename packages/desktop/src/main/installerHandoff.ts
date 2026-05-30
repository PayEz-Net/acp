/**
 * Installer → app handoff (installer-spec v2 §5; COL-6 M5.1).
 *
 * The NSIS installer (M5.2) cannot call the cloud project API (no
 * auth/network pre-login), so it OWNS the decision and writes a single
 * local artifact: the chosen workspace folder + recorded consent. The
 * FIRST AUTHENTICATED app launch executes that mandate — seeds the REAL
 * consent gate (`AppSettings.colonizationConsent`, the SAME flag the
 * spawn-orchestrator colonize wire-in (360f4e8) gates on) and records
 * the installer-decided root. colonizeWorkspace then runs consented via
 * the existing wire-in. Installer decides; the app carries it out.
 *
 * Consent-first (spec §2.3 / §8 AC7): we only seed consent when the
 * installer RECORDED it — never inferred, never silent. parseHandoff +
 * applyHandoff are pure (unit-tested); readAndApplyInstallerHandoff is
 * the thin best-effort glue (never throws).
 */
import type { AppSettings } from '../shared/types';

export interface InstallerHandoff {
  workspaceRoot: string;
  colonizationConsented: boolean;
  installerVersion?: string;
}

/** Pure: parse + validate the installer-written handoff JSON. */
export function parseHandoff(raw: string): InstallerHandoff | null {
  try {
    const j = JSON.parse(raw);
    if (j && typeof j.workspaceRoot === 'string' && j.workspaceRoot.trim()
        && typeof j.colonizationConsented === 'boolean') {
      return {
        workspaceRoot: j.workspaceRoot,
        colonizationConsented: j.colonizationConsented,
        installerVersion: typeof j.installerVersion === 'string' ? j.installerVersion : undefined,
      };
    }
  } catch { /* malformed → null */ }
  return null;
}

/**
 * Pure + idempotent: apply a parsed handoff to settings. Seeds the REAL
 * consent gate ONLY when the installer recorded consent and it is not
 * already set; records the installer-decided root once. Returns what
 * changed (idempotent re-apply changes nothing).
 */
export function applyHandoff(
  h: InstallerHandoff,
  get: () => AppSettings,
  set: (patch: Partial<AppSettings>) => void,
): { seededConsent: boolean; recordedRoot: boolean } {
  const s = get();
  let seededConsent = false;
  let recordedRoot = false;
  if (h.colonizationConsented === true && s.colonizationConsent !== true) {
    set({ colonizationConsent: true });
    seededConsent = true;
  }
  if (h.workspaceRoot && s.installerWorkspaceRoot !== h.workspaceRoot) {
    set({ installerWorkspaceRoot: h.workspaceRoot });
    recordedRoot = true;
  }
  return { seededConsent, recordedRoot };
}

/**
 * Glue: on first authenticated launch, read the installer handoff (if
 * the installer wrote one) and apply it. Best-effort — NEVER throws.
 */
export function readAndApplyInstallerHandoff(): void {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const electron = require('electron');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs = require('fs'); const path = require('path');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { getSettings, setSettings } = require('./store');
    const file = path.join(electron.app.getPath('userData'), 'installer-handoff.json');
    if (!fs.existsSync(file)) return;
    const h = parseHandoff(fs.readFileSync(file, 'utf8'));
    if (!h) return;
    const r = applyHandoff(
      h,
      getSettings,
      (patch) => setSettings({ ...getSettings(), ...patch }),
    );
    if (r.seededConsent || r.recordedRoot) {
      console.log(`[InstallerHandoff] applied: consent=${r.seededConsent} root=${r.recordedRoot} (${JSON.stringify(h.workspaceRoot)})`);
    }
  } catch (e) {
    console.error('[InstallerHandoff] read/apply failed (non-fatal):', e);
  }
}
