/**
 * Project Switch — Wave C Commit C per BAPert msg 1149.
 *
 * Atomic project-switch flow:
 *   1. Renderer calls `acp.project.switch(targetId)` via IPC
 *   2. Main process PUTs /v1/projects/current { project_id: targetId }
 *      to acp-api (which proxies to cloud)
 *   3. On 200: app.relaunch() + app.exit(0) — full app restart
 *   4. New boot's lifecycle-poller reads current-project (now targetId)
 *      and spawn-orchestrator re-instantiates the new project's team
 *
 * Replaces the existing broken in-process switch flow per Jon's flag
 * in msg 1149: "it needs to completely shut down the app entirely and
 * restart it." Per `feedback_project_is_instantiation_not_filter`, the
 * cleanest mechanical re-instantiation is via OS process exit + cold
 * restart — no in-process teardown coordination required.
 *
 * Errors:
 *   - 4xx / 5xx from cloud: surfaced via PROJECT_SWITCH_PROGRESS event,
 *     no restart. Renderer keeps user on current project.
 *   - Network failure: same path, error message includes 'unreachable'.
 */

import { app, ipcMain, BrowserWindow } from 'electron';
import { IPC_CHANNELS } from '../shared/types';
import { setNextBootOverlay } from './store';

const ACP_API_BASE = process.env.ACP_API_URL || 'http://127.0.0.1:3001';

interface SwitchRequest {
  targetProjectId: number;
  targetProjectName: string;
}

interface SwitchResult {
  success: boolean;
  errorCode?: string;
  errorMessage?: string;
}

async function putCurrentProject(targetProjectId: number): Promise<SwitchResult> {
  try {
    const res = await fetch(`${ACP_API_BASE}/v1/projects/current`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project_id: targetProjectId }),
    });
    const text = await res.text();
    let body: { success?: boolean; error?: { code?: string; message?: string } } = {};
    try { body = text ? JSON.parse(text) : {}; } catch { /* ignore */ }
    if (!res.ok) {
      return {
        success: false,
        errorCode: body?.error?.code || `HTTP_${res.status}`,
        errorMessage: body?.error?.message || `acp-api returned HTTP ${res.status}`,
      };
    }
    return { success: true };
  } catch (err) {
    return {
      success: false,
      errorCode: 'CLOUD_UNREACHABLE',
      errorMessage: err instanceof Error ? err.message : 'Network error contacting acp-api',
    };
  }
}

export function setupProjectSwitchHandler(mainWindow: BrowserWindow | null): void {
  ipcMain.handle(IPC_CHANNELS.PROJECT_SWITCH, async (_event, request: unknown): Promise<SwitchResult> => {
    // Required shape: { targetProjectId: number, targetProjectName: string }.
    // Greenfield rule (feedback_no_backward_compat_in_greenfield) — no
    // bare-number legacy form. Aurum R1 overlay UX needs the name to
    // paint the boot overlay, so it's required.
    if (
      !request
      || typeof request !== 'object'
      || typeof (request as SwitchRequest).targetProjectId !== 'number'
      || !Number.isFinite((request as SwitchRequest).targetProjectId)
      || typeof (request as SwitchRequest).targetProjectName !== 'string'
    ) {
      return {
        success: false,
        errorCode: 'VALIDATION_ERROR',
        errorMessage: 'PROJECT_SWITCH requires { targetProjectId: number, targetProjectName: string }',
      };
    }
    const { targetProjectId, targetProjectName } = request as SwitchRequest;

    console.log(`[ProjectSwitch] switching to project=${targetProjectId} (name=${targetProjectName})`);
    mainWindow?.webContents.send(IPC_CHANNELS.PROJECT_SWITCH_PROGRESS, {
      phase: 'cloud-pending',
      targetProjectId,
    });

    const result = await putCurrentProject(targetProjectId);
    if (!result.success) {
      console.warn(`[ProjectSwitch] cloud PUT failed for project=${targetProjectId}: ${result.errorCode} ${result.errorMessage}`);
      mainWindow?.webContents.send(IPC_CHANNELS.PROJECT_SWITCH_PROGRESS, {
        phase: 'error',
        targetProjectId,
        errorCode: result.errorCode,
        errorMessage: result.errorMessage,
      });
      return result;
    }

    console.log(`[ProjectSwitch] cloud PUT succeeded for project=${targetProjectId} — relaunching ACP`);
    mainWindow?.webContents.send(IPC_CHANNELS.PROJECT_SWITCH_PROGRESS, {
      phase: 'restarting',
      targetProjectId,
    });

    // Aurum R1 (msg 1156): persist next-boot overlay so the pre-mount
    // HTML can paint "Switching to <project_name>…" before React loads
    // on the cold boot. Zero-flash UX — user sees a continuous surface
    // from click through restart through landing.
    setNextBootOverlay({
      project_id: targetProjectId,
      project_name: targetProjectName,
    });

    // Give the renderer a beat to show the 'Switching...' UI before
    // the process exits. 250ms is enough for the IPC event to land in
    // the renderer paint pipeline.
    setTimeout(() => {
      app.relaunch();
      app.exit(0);
    }, 250);

    return { success: true };
  });

  console.log('[ProjectSwitch] handler registered on IPC_CHANNELS.PROJECT_SWITCH');
}
