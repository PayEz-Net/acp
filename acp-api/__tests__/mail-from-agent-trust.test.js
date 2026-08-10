/**
 * 119073 (sidecar half): from_agent is no longer trusted from the body. The
 * transport identity (X-ACP-Agent header / local-auth agentName) is
 * authoritative — a disagreeing body value is rejected 403 IDENTITY_MISMATCH,
 * a missing one is derived. Harness mirrors mail-session-inactive.test.js.
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

function mountApp() {
  const app = express();
  app.use(express.json());
  app.use('/v1/mail', mailProxyRoutes(cfg));
  return app;
}

let lastRequest = { url: null, init: null };

beforeAll(() => {
  const farExp = Math.floor((Date.now() + 3600_000) / 1000);
  const jwt = `${b64url({ alg: 'none', typ: 'JWT' })}.${b64url({ client_id: '9', exp: farExp, sub: 'test' })}.sig`;
  setSession({ accessToken: jwt, refreshToken: 'r', expiresAt: new Date(Date.now() + 3600_000), userId: '903-119073', email: 'test@test' });
});

beforeEach(() => {
  lastRequest = { url: null, init: null };
  globalThis.fetch = async (url, init) => {
    lastRequest = { url: String(url), init };
    return new Response(JSON.stringify({ success: true, data: { message_id: 1 } }), { status: 201 });
  };
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe('from_agent is not trusted from the body (119073)', () => {
  it('rejects a body from_agent that disagrees with X-ACP-Agent, without calling the cloud', async () => {
    const res = await request(mountApp())
      .post('/v1/mail/send')
      .set('X-ACP-Agent', 'NextPert')
      .send({ from_agent: 'QAPert', to: ['BAPert'], subject: 'S', body: 'B' });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('IDENTITY_MISMATCH');
    expect(res.body.error.message).toContain('QAPert');
    expect(res.body.error.message).toContain('NextPert');
    expect(lastRequest.url).toBeNull();
  });

  it('derives from_agent from the transport identity when the body omits it', async () => {
    const res = await request(mountApp())
      .post('/v1/mail/send')
      .set('X-ACP-Agent', 'NextPert')
      .send({ to: ['BAPert'], subject: 'S', body: 'B' });

    expect(res.status).toBe(201);
    const forwardBody = JSON.parse(lastRequest.init.body);
    expect(forwardBody.from_agent).toBe('NextPert');
    expect(forwardBody.claimed_identity).toBe('NextPert');
  });

  it('accepts an agreeing from_agent (case-insensitive) and forwards the transport casing', async () => {
    const res = await request(mountApp())
      .post('/v1/mail/send')
      .set('X-ACP-Agent', 'NextPert')
      .send({ from_agent: 'nextpert', to: ['BAPert'], subject: 'S', body: 'B' });

    expect(res.status).toBe(201);
    expect(JSON.parse(lastRequest.init.body).from_agent).toBe('NextPert');
  });

  it('still 400s when neither body nor transport carries an identity', async () => {
    const res = await request(mountApp())
      .post('/v1/mail/send')
      .send({ to: ['BAPert'], subject: 'S', body: 'B' });

    expect(res.status).toBe(400);
    expect(lastRequest.url).toBeNull();
  });
});
