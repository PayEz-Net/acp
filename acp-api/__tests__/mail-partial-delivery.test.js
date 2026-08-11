/**
 * 170009 (sidecar half): one unresolvable recipient must NOT void the whole
 * message. Locally-unknown names are dropped per-recipient and merged into
 * the cloud's `rejected` report; the send 404s only when NOTHING resolves.
 *
 * Harness mirrors mail-session-inactive.test.js: stubs the network edge
 * (global fetch) and passes a stub contractorService; client calls go
 * through supertest.
 */
import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import mailProxyRoutes from '../api/routes/mailProxy.js';
import { setSession } from '../api/auth/tokenManager.js';

function b64url(o) {
  return Buffer.from(JSON.stringify(o)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const cfg = { idpUrl: 'http://idp.test', vibeApiUrl: 'http://cloud.test', acpLocalSecret: 'secret' };
const realFetch = globalThis.fetch;

// Local roster: BAPert and NextPert known; anything else rejected (AC-11).
const stubContractorService = {
  resolveRecipient: async (_from, name) =>
    ['BAPert', 'NextPert'].includes(name)
      ? { action: 'passthrough', agent: { name } }
      : { action: 'rejected', error: `Unknown recipient "${name}"` },
  checkDoneAutoComplete: async () => {},
};

function mountApp() {
  const app = express();
  app.use(express.json());
  app.use('/v1/mail', mailProxyRoutes(cfg, undefined, stubContractorService));
  return app;
}

let lastRequest = { url: null, init: null };
let upstream = { status: 201, body: { success: true, data: { message_id: 1, rejected: [] } } };

beforeAll(() => {
  const farExp = Math.floor((Date.now() + 3600_000) / 1000);
  const jwt = `${b64url({ alg: 'none', typ: 'JWT' })}.${b64url({ client_id: '9', exp: farExp, sub: 'test' })}.sig`;
  setSession({ accessToken: jwt, refreshToken: 'r', expiresAt: new Date(Date.now() + 3600_000), userId: '903-pd', email: 'test@test' });
});

beforeEach(() => {
  upstream = { status: 201, body: { success: true, data: { message_id: 1, rejected: [] } } };
  lastRequest = { url: null, init: null };
  globalThis.fetch = async (url, init) => {
    lastRequest = { url: String(url), init };
    return new Response(JSON.stringify(upstream.body), { status: upstream.status });
  };
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe('per-recipient reject-and-report (170009)', () => {
  it('forwards only resolvable recipients and merges local rejects into the response', async () => {
    const res = await request(mountApp())
      .post('/v1/mail/send')
      .send({ from_agent: 'NextPert', to: ['BAPert', 'Ghost'], subject: 'S', body: 'B' });

    expect(res.status).toBe(201);
    // The cloud saw only the resolvable name...
    const forwardBody = JSON.parse(lastRequest.init.body);
    expect(forwardBody.to).toEqual(['BAPert']);
    // ...and the caller sees the merged reject report.
    expect(res.body.data.rejected).toEqual(['Ghost']);
  });

  it('preserves cloud-side rejects alongside local ones', async () => {
    upstream = { status: 201, body: { success: true, data: { message_id: 2, rejected: ['OffTeamPert'] } } };
    const res = await request(mountApp())
      .post('/v1/mail/send')
      .send({ from_agent: 'NextPert', to: ['BAPert', 'Ghost'], subject: 'S', body: 'B' });

    expect(res.status).toBe(201);
    expect(res.body.data.rejected).toEqual(['OffTeamPert', 'Ghost']);
  });

  it('still 404s when NO recipient resolves — and never calls the cloud', async () => {
    const res = await request(mountApp())
      .post('/v1/mail/send')
      .send({ from_agent: 'NextPert', to: ['Ghost'], subject: 'S', body: 'B' });

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('UNKNOWN_RECIPIENT');
    expect(res.body.error.message).toContain('Ghost');
    expect(lastRequest.url).toBeNull();
  });
});
