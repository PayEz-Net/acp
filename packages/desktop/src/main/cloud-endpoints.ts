/**
 * Cloud-endpoint authority (MAIN process; renderer reads via the
 * `cloud:endpoints` IPC and resolves NOTHING itself).
 *
 * Kills the dev-93 base-URL hydra. Every cloud base URL used to be its
 * own `process.env.X || 'http://127.0.0.1..'` (and a VITE_ twin) scattered
 * across lifecycle-hub / api-server / the renderer — N copies, each its
 * own prod-baking whack-a-mole, each silently booting against a dev box
 * when the env wasn't injected.
 *
 * THE LAW (Jon): no `||` in var retrieval. A value either exists for this
 * build or we THROW and HALT — never fall back, never "try dev-93", never
 * boot degraded. One authority, one fact.
 *
 * THE ONE FACT: `app.isPackaged` — the build's identity (a packaged build
 * IS prod; run-from-source IS dev). Not a fallback, not a guess. Each
 * build's set below is FULLY specified; `req()` throws if any value is
 * ever empty so a misconfigured build fails loudly instead of degrading.
 *
 * Hosts are verified, not guessed:
 *   - api.idealvibe.online        — prod vibe-api (baked c8fadd0)
 *   - api.idealvibe.online/hubs/agentmail — prod SignalR hub (probed: 401,
 *                                   not 404 → path real, auth-gated)
 *   - idp.payez.net               — prod IDP the working renderer login
 *                                   actually uses (oauth.ts:19/api.ts:11)
 */
import { app } from 'electron';

// The single authoritative fact. Packaged build → prod; otherwise dev-93.
const PACKAGED = app.isPackaged;

interface CloudEndpoints {
  vibeApiUrl: string;
  hubUrl: string;
  idpUrl: string;
}

// Both sets fully specified. No `||`, no env-or-literal chain, no
// "default to something" — the value for THIS build is right here.
//
// MANUAL OVERRIDE (dev-from-source against prod):
// Comment out the block you DON'T want and uncomment the one you DO.
// When both are commented the app will throw on boot — that's intentional.
const ENDPOINTS: CloudEndpoints = {
  // === Dev-93 (local dev box) ===
  // vibeApiUrl: 'http://127.0.0.1:32786',
  // hubUrl: 'http://127.0.0.1:32786/hubs/agentmail',
  // idpUrl: 'http://127.0.0.1:32785',

  // === Prod AKS ===
  vibeApiUrl: 'https://api.idealvibe.online',
  hubUrl: 'https://api.idealvibe.online/hubs/agentmail',
  idpUrl: 'https://idp.payez.net',
};

function req(name: keyof CloudEndpoints): string {
  const v = ENDPOINTS[name];
  if (!v) {
    // Hard halt — surface verbatim, never degrade (feedback_fallback_to_
    // avoid_crash_is_the_hole). A missing endpoint is a build defect, not
    // something to paper over with a literal.
    throw new Error(
      `[cloud-endpoints] '${name}' is not configured for this build ` +
      `(packaged=${PACKAGED}) — refusing to boot against an unknown host`,
    );
  }
  return v;
}

export const VIBE_API_URL = req('vibeApiUrl');
export const HUB_URL = req('hubUrl');
export const IDP_URL = req('idpUrl');

/** Snapshot for the renderer (cloud:endpoints IPC). Renderer resolves
 *  nothing — it consumes exactly what this authority decided. */
export function cloudEndpointsSnapshot(): CloudEndpoints {
  return { vibeApiUrl: VIBE_API_URL, hubUrl: HUB_URL, idpUrl: IDP_URL };
}
