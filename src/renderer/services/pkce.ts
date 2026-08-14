/**
 * PKCE (RFC 7636) — code verifier / challenge generation.
 *
 * ── WHY THIS EXISTS (173407 / 175047) ───────────────────────────────────────
 * The desktop app is a PUBLIC OAuth client: it runs on the user's machine, so
 * anything shipped inside it is readable by whoever runs it. Today it holds a
 * provider client_secret and performs the token exchange in the RENDERER
 * (oauth.ts), which means that secret is on every user's laptop. PKCE is what
 * replaces it — a per-authorization secret generated at runtime, never stored,
 * never shipped.
 *
 * Ratified design (BAPert 21218): the desktop authorizes against OUR IDP as a
 * public client using PKCE, and the IDP performs the provider exchange
 * server-side with the provider secret it already holds. So these helpers serve
 * the desktop<->IDP leg. They are deliberately NOT wired into the existing
 * direct-to-provider exchange, which is the option that was considered and
 * rejected — wiring them there would build the path we chose not to take.
 *
 * ── WHY NOT Math.random() ───────────────────────────────────────────────────
 * The verifier is the only thing standing between an intercepted authorization
 * code and a session. It must come from a CSPRNG. crypto.getRandomValues is
 * available in the Electron renderer; Math.random is predictable and would make
 * the whole exercise decorative.
 */

/** RFC 7636 §4.1: 43-128 chars from the unreserved set. 32 bytes -> 43 chars. */
const VERIFIER_BYTES = 32;

/** base64url per RFC 7636 §A: base64, then +/ -> -_ , and strip padding. */
function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Generate a fresh code_verifier. One per authorization attempt — never reuse,
 * never persist. Reusing a verifier across attempts would let a code
 * intercepted from attempt A be redeemed during attempt B.
 */
export function generateCodeVerifier(): string {
  const bytes = new Uint8Array(VERIFIER_BYTES);
  crypto.getRandomValues(bytes);
  return base64UrlEncode(bytes);
}

/**
 * Derive the S256 challenge. Async because SubtleCrypto is.
 *
 * We do NOT support the 'plain' method. RFC 7636 permits it, but plain sends
 * the verifier itself on the authorize request — so anything that could
 * intercept the code could also read the verifier, which defeats the point.
 * S256 or nothing.
 */
export async function deriveCodeChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return base64UrlEncode(new Uint8Array(digest));
}

/** Convenience: both halves for one authorization attempt. */
export async function createPkcePair(): Promise<{
  codeVerifier: string;
  codeChallenge: string;
  codeChallengeMethod: 'S256';
}> {
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = await deriveCodeChallenge(codeVerifier);
  return { codeVerifier, codeChallenge, codeChallengeMethod: 'S256' };
}
