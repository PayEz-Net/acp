/**
 * Cloud-environment authority (MAIN process; renderer reads via the
 * `cloud:endpoints` IPC and resolves NOTHING itself).
 *
 * WO #292: the active environment is BAKED at build time by `scripts/gen-env.cjs`
 * into `./env.generated.ts` (which carries ONLY the active env's hosts — a prod
 * build's generated source contains no dev literal). This module validates that
 * baked set and exposes it.
 *
 * THE LAW (Jon): no `||` in host retrieval, no env-or-literal chain, no runtime
 * fallback. A missing/incomplete baked set THROWS and halts — a build defect is
 * never papered over with a literal. Switching env is a BUILD-TIME choice
 * (`npm run dev:93` / `dev:prod` / `dist` / `dist:93`), never a code edit.
 *
 * Design: `Agents/NextPert/designs/acp-env-switching-design-v1.md`.
 */
import { app } from 'electron';
import { ACP_ENV_NAME, ACP_ENDPOINTS } from './env.generated';

function req(name: 'idpUrl' | 'vibeApiUrl' | 'hubUrl'): string {
  const v = ACP_ENDPOINTS[name];
  if (!v) {
    throw new Error(
      `[env] '${name}' is not configured for this build (ACP_ENV='${ACP_ENV_NAME}') ` +
      `— refusing to boot against an unknown host`,
    );
  }
  return v;
}

export const VIBE_API_URL = req('vibeApiUrl');
export const HUB_URL = req('hubUrl');
export const IDP_URL = req('idpUrl');
export { ACP_ENV_NAME };

/**
 * dev-only `/dev/impersonate` harness host. Absent in prod BY DESIGN (no
 * impersonation in prod) — so this is `null` in a prod build. Callers MUST
 * handle null (the impersonate path is a dev-only capability and throws if
 * reached without it). No `||` dev-93 fallback (the old idp-client.ts:13 bug).
 */
export const IDP_INTERNAL_URL: string | null = ACP_ENDPOINTS.idpInternalUrl ?? null;

export const IS_PACKAGED = app.isPackaged;

/**
 * A PACKAGED build baked as anything other than prod is a deliberate `dist:93`
 * internal build — legal for internal testing, but it must NEVER masquerade as
 * the public installer. Surfaced loudly here and as the "INTERNAL DEV BUILD"
 * marker in the renderer (WO #292 principle 3 / Aurum 6028 visibility).
 */
export const IS_INTERNAL_DEV_BUILD = IS_PACKAGED && ACP_ENV_NAME !== 'prod';
if (IS_INTERNAL_DEV_BUILD) {
  console.warn(
    `[env] INTERNAL DEV BUILD — packaged installer baked ACP_ENV='${ACP_ENV_NAME}' ` +
    `(not prod). This is a dist:93 internal build, NOT for public release.`,
  );
}

/**
 * Snapshot for the renderer (`cloud:endpoints` IPC). The renderer resolves
 * nothing — it consumes exactly what this authority decided, plus the env
 * identity for the read-only env indicator (WO #292 / Aurum 6028).
 */
export interface CloudEndpointsSnapshot {
  vibeApiUrl: string;
  hubUrl: string;
  idpUrl: string;
  envName: string;
  isPackaged: boolean;
  isInternalDevBuild: boolean;
}

export function cloudEndpointsSnapshot(): CloudEndpointsSnapshot {
  return {
    vibeApiUrl: VIBE_API_URL,
    hubUrl: HUB_URL,
    idpUrl: IDP_URL,
    envName: ACP_ENV_NAME,
    isPackaged: IS_PACKAGED,
    isInternalDevBuild: IS_INTERNAL_DEV_BUILD,
  };
}
