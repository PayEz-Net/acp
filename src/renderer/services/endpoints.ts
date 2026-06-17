/**
 * Renderer-side cloud-endpoint accessor (WO #292).
 *
 * The renderer resolves NOTHING — it asks the MAIN process (the env authority,
 * `src/main/env.ts`, baked at build time) over the `cloud:endpoints` IPC. There
 * are no host literals in the renderer at all.
 *
 * COLD-START SAFE: caches the in-flight PROMISE (not a sync value), so a call
 * made before the IPC has resolved AWAITS it and can never return a host-less /
 * `undefined` endpoint, and all concurrent callers share ONE round-trip.
 */
export interface RendererEndpoints {
  vibeApiUrl: string;
  hubUrl: string;
  idpUrl: string;
  envName: string;
  isPackaged: boolean;
  isInternalDevBuild: boolean;
}

let inFlight: Promise<RendererEndpoints> | null = null;

/** Resolve the active cloud endpoints (cached in-flight promise). */
export function getEndpoints(): Promise<RendererEndpoints> {
  return (inFlight ??= window.electronAPI.getCloudEndpoints());
}

/** The active IDP base URL (no literal, no fallback — main decided it). */
export async function getIdpUrl(): Promise<string> {
  return (await getEndpoints()).idpUrl;
}
