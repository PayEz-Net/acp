/**
 * 118552 (sidecar half): the SESSION_INACTIVE rewrite prescribes a verbatim
 * retry — so the send must be idempotent. The sidecar derives a stable
 * content-hash idempotency key when the caller supplies none, and the
 * send-specific rewrite says VERBATIM (a verbatim retry dedupes server-side;
 * an edited re-send intentionally does not).
 *
 * Harness mirrors mail-session-inactive.test.js.
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

let lastRequests = [];
let upstream = { status: 201, body: { success: true, data: { message_id: 1 } } };

beforeAll(() => {
  const farExp = Math.floor((Date.now() + 3600_000) / 1000);
  const jwt = `${b64url({ alg: 'none', typ: 'JWT' })}.${b64url({ client_id: '9', exp: farExp, sub: 'test' })}.sig`;
  setSession({ accessToken: jwt, refreshToken: 'r', expiresAt: new Date(Date.now() + 3600_000), userId: '903-idem', email: 'test@test' });
});

beforeEach(() => {
  upstream = { status: 201, body: { success: true, data: { message_id: 1 } } };
  lastRequests = [];
  globalThis.fetch = async (url, init) => {
    lastRequests.push({ url: String(url), init });
    return new Response(JSON.stringify(upstream.body), { status: upstream.status });
  };
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

const SEND = { from_agent: 'NextPert', to: ['BAPert'], subject: 'S', body: 'B' };

describe('idempotent send (118552)', () => {
  it('derives an identical idempotency key for a verbatim retry', async () => {
    await request(mountApp()).post('/v1/mail/send').send(SEND);
    await request(mountApp()).post('/v1/mail/send').send(SEND);

    expect(lastRequests).toHaveLength(2);
    const keys = lastRequests.map((r) => JSON.parse(r.init.body).idempotency_key);
    expect(keys[0]).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(keys[1]).toBe(keys[0]);
  });

  it('derives a DIFFERENT key for an edited re-send', async () => {
    await request(mountApp()).post('/v1/mail/send').send(SEND);
    await request(mountApp()).post('/v1/mail/send').send({ ...SEND, body: 'B edited' });

    const keys = lastRequests.map((r) => JSON.parse(r.init.body).idempotency_key);
    expect(keys[1]).not.toBe(keys[0]);
  });

  it('passes a caller-supplied key through untouched', async () => {
    await request(mountApp()).post('/v1/mail/send').send({ ...SEND, idempotency_key: 'caller-key-1' });

    const key = JSON.parse(lastRequests[0].init.body).idempotency_key;
    expect(key).toBe('caller-key-1');
  });

  it('the send-path SESSION_INACTIVE rewrite prescribes a VERBATIM retry and names the dedupe', async () => {
    upstream = { status: 404, body: { success: false, error: { code: 'SESSION_INACTIVE', message: 'x' } } };
    const res = await request(mountApp()).post('/v1/mail/send').send(SEND);

    expect(res.status).toBe(503);
    expect(res.body.error.message).toMatch(/verbatim/i);
    expect(res.body.error.message).toMatch(/deduplicated/i);
  });
});
