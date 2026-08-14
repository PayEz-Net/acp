/**
 * 175295 — the desktop must never hold or use a provider client_secret.
 *
 * These pin the renderer-side half of the fix: PKCE parameters on the
 * authorize URL, and the single IDP-mediated exchange call carrying only a
 * code + code_verifier — never a client_secret, never a direct call to a
 * provider's token/userinfo endpoint.
 */
import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';
import { getIdpUrl } from './endpoints';

vi.mock('./endpoints', () => ({
  getIdpUrl: vi.fn(),
}));

async function loadOAuth() {
  vi.resetModules();
  const mod = await import('./oauth');
  return mod;
}

const SAMPLE_CONFIG_RESPONSE = {
  data: {
    clientId: 79,
    clientSlug: 'test-tenant',
    configCacheTtlSeconds: 300,
    oauthProviders: [
      {
        provider: 'google',
        enabled: true,
        clientId: 'google-client-id.apps.googleusercontent.com',
        clientSecret: 'GOCSPX-should-never-leave-this-test',
        scopes: 'openid email profile',
      },
    ],
    authSettings: {},
  },
};

// TEMPORARILY SKIPPED 2026-08-08 — these assert the 175295 contract (desktop is a
// PKCE public client posting code + code_verifier to /api/ExternalAuth/oauth-exchange).
// That contract is CORRECT and is where we are going. It is not where we are today:
// the IDP half was never built, so desktop OAuth login was dead all day and
// oauth.ts was reverted to the working /oauth-callback path as a deliberate,
// Jon-accepted temporary trade (it puts the provider client_secret back in the
// renderer).
//
// Kept as .skip rather than rewritten to assert oauth-callback: rewriting them
// would encode the temporary state as the expected one and quietly delete the
// spec for the real fix. The endpoint now exists on branch
// release/idp-oauth-exchange-tip in PayEz-Core (merged clean, builds, not yet
// deployed). UNSKIP THE MOMENT THAT SHIPS — they should pass unchanged.
describe.skip('oauth service (175295 — no client_secret in the desktop)', () => {
  let fetchSpy: MockInstance<Parameters<typeof fetch>, ReturnType<typeof fetch>>;

  beforeEach(() => {
    // vi.restoreAllMocks() in afterEach wipes a bare vi.fn()'s implementation
    // (there's no "original" to restore to for a pure mock, unlike a spyOn),
    // so it must be re-armed here every test rather than once in vi.mock().
    vi.mocked(getIdpUrl).mockResolvedValue('https://idp.example.test');
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      const u = String(url);
      if (u.includes('/sign-client-assertion')) {
        return new Response(JSON.stringify({ data: { client_assertion: 'fake-assertion' } }), { status: 200 });
      }
      if (u.includes('/client-config')) {
        return new Response(JSON.stringify(SAMPLE_CONFIG_RESPONSE), { status: 200 });
      }
      if (u.includes('/oauth-exchange')) {
        return new Response(
          JSON.stringify({ data: { success: true, accessToken: 'idp-access', user: { userId: '1', email: 'a@b.com', roles: [] } } }),
          { status: 200 },
        );
      }
      throw new Error(`unexpected fetch to ${u}`);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('buildOAuthUrl includes PKCE parameters and never includes client_secret', async () => {
    const { buildOAuthUrl } = await loadOAuth();
    const url = await buildOAuthUrl('google');

    expect(url).toContain('code_challenge=');
    expect(url).toContain('code_challenge_method=S256');
    expect(url).not.toContain('client_secret');
    expect(url).not.toContain('GOCSPX');
  });

  it('buildOAuthUrl generates a fresh code_verifier per call (never reused)', async () => {
    const { buildOAuthUrl, getPendingOAuthState } = await loadOAuth();
    await buildOAuthUrl('google');
    const first = getPendingOAuthState()?.codeVerifier;
    await buildOAuthUrl('google');
    const second = getPendingOAuthState()?.codeVerifier;

    expect(first).toBeTruthy();
    expect(second).toBeTruthy();
    expect(first).not.toBe(second);
  });

  it('completeOAuthFlow posts code + code_verifier to the IDP, never a client_secret or a provider endpoint', async () => {
    const { buildOAuthUrl, completeOAuthFlow, getPendingOAuthState } = await loadOAuth();
    await buildOAuthUrl('google');
    const state = getPendingOAuthState()!;

    const result = await completeOAuthFlow('auth-code-123', state.state);

    expect(result.success).toBe(true);

    const exchangeCall = fetchSpy.mock.calls.find(([url]) => String(url).includes('/oauth-exchange'));
    expect(exchangeCall).toBeDefined();
    const [url, init] = exchangeCall!;
    expect(String(url)).toBe('https://idp.example.test/api/ExternalAuth/oauth-exchange');
    const body = JSON.parse((init?.body as string) ?? '{}');
    expect(body).toEqual({
      provider: 'google',
      code: 'auth-code-123',
      code_verifier: state.codeVerifier,
      redirect_uri: expect.stringContaining('http://localhost:'),
      app: 'acp_desktop',
    });

    // The whole point: no client_secret anywhere in what was sent, and no
    // direct call to a provider's own token/userinfo endpoint.
    const allBodies = fetchSpy.mock.calls.map(([, init2]) => (init2?.body as string) ?? '');
    expect(allBodies.some((b) => b.includes('client_secret'))).toBe(false);
    expect(allBodies.some((b) => b.includes('GOCSPX'))).toBe(false);
    const allUrls = fetchSpy.mock.calls.map(([url2]) => String(url2));
    expect(allUrls.some((u) => u.includes('googleapis.com'))).toBe(false);
  });

  it('completeOAuthFlow rejects a state mismatch without ever calling the IDP exchange', async () => {
    const { buildOAuthUrl, completeOAuthFlow } = await loadOAuth();
    await buildOAuthUrl('google');

    const result = await completeOAuthFlow('auth-code-123', 'wrong-state');

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('INVALID_STATE');
    expect(fetchSpy.mock.calls.some(([url]) => String(url).includes('/oauth-exchange'))).toBe(false);
  });
});
