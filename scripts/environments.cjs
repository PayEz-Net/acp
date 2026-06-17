/**
 * ACP cloud-environment map — THE single source of truth for every cloud host
 * the app talks to (WO #292).
 *
 * ┌──────────────────────────────────────────────────────────────────────────┐
 * │ BUILD-TIME ONLY. NEVER import this from a runtime module (src/main/* or    │
 * │ src/renderer/*). A runtime import bundles the WHOLE map — including the    │
 * │ dev-93 hosts — into a prod artifact and defeats the immutability guarantee │
 * │ (a prod build would then physically contain `127.0.0.1`). Only             │
 * │ scripts/gen-env.cjs reads this, and it writes ONLY the active env's hosts  │
 * │ into src/main/env.generated.ts. (QA greps that no src/ module imports it.) │
 * └──────────────────────────────────────────────────────────────────────────┘
 *
 * Adding an environment (e.g. 'staging') = ONE entry here + one selector value.
 * No new files, no per-env branches, no host literals anywhere else.
 *
 * NOTE on `idpInternalUrl`: dev-ONLY. It is the `/dev/impersonate` harness host
 * (idp-client.ts:139), which exists only on the dev box and is deliberately
 * absent in prod (impersonation is a prod-excluded capability). prod OMITS it;
 * the impersonate path throws loudly in a build where it is absent.
 */
const ENVIRONMENTS = {
  dev93: {
    idpUrl: 'http://127.0.0.1:32785',
    idpInternalUrl: 'http://127.0.0.1:32774', // dev-only: /dev/impersonate harness
    vibeApiUrl: 'http://127.0.0.1:32786',
    hubUrl: 'http://127.0.0.1:32786/hubs/agentmail',
  },
  prod: {
    idpUrl: 'https://idp.payez.net',
    // idpInternalUrl intentionally OMITTED — no /dev/impersonate in prod.
    vibeApiUrl: 'https://api.idealvibe.online',
    hubUrl: 'https://api.idealvibe.online/hubs/agentmail',
  },
};

/** Fields every env MUST define (the resolver hard-fails if any is missing). */
const REQUIRED_KEYS = ['idpUrl', 'vibeApiUrl', 'hubUrl'];

module.exports = { ENVIRONMENTS, ENV_NAMES: Object.keys(ENVIRONMENTS), REQUIRED_KEYS };
