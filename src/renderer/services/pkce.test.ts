import { describe, it, expect } from 'vitest';
import { generateCodeVerifier, deriveCodeChallenge, createPkcePair } from './pkce';

describe('pkce (RFC 7636)', () => {
  it('generateCodeVerifier produces a fresh, sufficiently long, unreserved-charset value each call', () => {
    const a = generateCodeVerifier();
    const b = generateCodeVerifier();
    expect(a).not.toBe(b);
    // RFC 7636 §4.1: 43-128 chars.
    expect(a.length).toBeGreaterThanOrEqual(43);
    expect(a.length).toBeLessThanOrEqual(128);
    // base64url unreserved set only — no +, /, or = padding.
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('deriveCodeChallenge is deterministic (same verifier -> same challenge) and base64url-safe', async () => {
    const verifier = 'a-fixed-verifier-for-this-test-1234567890';
    const c1 = await deriveCodeChallenge(verifier);
    const c2 = await deriveCodeChallenge(verifier);
    expect(c1).toBe(c2);
    expect(c1).toMatch(/^[A-Za-z0-9_-]+$/);
    // S256 output is not the verifier itself — plain-method-shaped leakage
    // would defeat the whole point (see the module header on plain vs S256).
    expect(c1).not.toBe(verifier);
  });

  it('different verifiers derive different challenges', async () => {
    const c1 = await deriveCodeChallenge(generateCodeVerifier());
    const c2 = await deriveCodeChallenge(generateCodeVerifier());
    expect(c1).not.toBe(c2);
  });

  it('createPkcePair returns a matching, S256 verifier/challenge pair', async () => {
    const pair = await createPkcePair();
    expect(pair.codeChallengeMethod).toBe('S256');
    const recomputed = await deriveCodeChallenge(pair.codeVerifier);
    expect(recomputed).toBe(pair.codeChallenge);
  });
});
