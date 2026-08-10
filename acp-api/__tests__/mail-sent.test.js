/**
 * 170011 (sidecar half): GET /v1/mail/sent/:agent proxies the outbox endpoint
 * with the same project_id stamp as every other mail route. Harness mirrors
 * mail-session-inactive.test.js.
 */
import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import mailProxyRoutes from '../api/routes/mailProxy.js';
import { setSession } from '../api/auth/tokenManager.js';
import * as projectsCache from '../api/projects/cache.js';

function b64url(o) {
  return Buffer.from(JSON.stringify(o)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const cfg = { idpUrl: 'http://idp.test', vibeApiUrl: 'http://cloud.test', acpLocalSecret: 'secret' };
const USER_ID = '903-sent';
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
  setSession({ accessToken: jwt, refreshToken: 'r', expiresAt: new Date(Date.now() + 3600_000), userId: USER_ID, email: 'test@test' });
});

beforeEach(() => {
  lastRequest = { url: null, init: null };
  projectsCache.current.set(USER_ID, {
    current_project_id: 31,
    project: null,
    current_project_state: 'set',
  });
  globalThis.fetch = async (url, init) => {
    lastRequest = { url: String(url), init };
    return new Response(
      JSON.stringify({ success: true, data: { agent: 'NextPert', messages: [] } }),
      { status: 200 },
    );
  };
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe('sent-mail proxy (170011)', () => {
  it('forwards GET /sent/:agent upstream with the project stamp', async () => {
    const res = await request(mountApp()).get('/v1/mail/sent/NextPert');

    expect(res.status).toBe(200);
    expect(lastRequest.url).toContain('/v1/agentmail/sent/NextPert');
    expect(lastRequest.url).toContain('project_id=31');
  });
});
