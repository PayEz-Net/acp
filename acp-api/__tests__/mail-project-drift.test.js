/**
 * 139077 (option 3 — drift visibility): the current project is a USER-scoped
 * setting whose effects are TEAM-wide — every agent's mail is stamped with it
 * and resolves against that project's team. When it drifts mid-process, the
 * whole team "not found"s at once and every prior diagnosis misread it
 * (agents declared deregistered; roster "churn"). The sidecar now logs an
 * unmissable CURRENT-PROJECT DRIFT error naming old -> new the moment the
 * stamped project changes within a process lifetime.
 *
 * Harness mirrors mail-session-inactive.test.js: stubs only the network edge
 * (global fetch); client calls go through supertest.
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
const USER_ID = '903-drift';

const realFetch = globalThis.fetch;

function mountApp() {
  const app = express();
  app.use(express.json());
  app.use('/v1/mail', mailProxyRoutes(cfg));
  return app;
}

function setCurrentProject(projectId) {
  projectsCache.current.set(USER_ID, {
    current_project_id: projectId,
    project: null,
    current_project_state: 'set',
  });
}

beforeAll(() => {
  const farExp = Math.floor((Date.now() + 3600_000) / 1000);
  const jwt = `${b64url({ alg: 'none', typ: 'JWT' })}.${b64url({ client_id: '9', exp: farExp, sub: 'test' })}.sig`;
  setSession({ accessToken: jwt, refreshToken: 'r', expiresAt: new Date(Date.now() + 3600_000), userId: USER_ID, email: 'test@test' });
});

beforeEach(() => {
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ success: true, data: { agents: [] } }), { status: 200 });
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe('current-project drift detection (139077)', () => {
  it('logs an unmissable error naming old -> new when the stamped project changes', async () => {
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      // Baseline observation (no drift on first sight).
      setCurrentProject(31);
      await request(mountApp()).get('/v1/mail/agents');
      // Drift: same user, same process, different project — the 2026-08 failure shape.
      setCurrentProject(18);
      await request(mountApp()).get('/v1/mail/agents');

      const driftLogs = errSpy.mock.calls
        .map((c) => String(c[0]))
        .filter((m) => m.includes('CURRENT-PROJECT DRIFT DETECTED'));
      expect(driftLogs).toHaveLength(1);
      expect(driftLogs[0]).toContain('31 -> 18');
      expect(driftLogs[0]).toContain('139077');
    } finally {
      errSpy.mockRestore();
    }
  });

  it('stays silent while the project is stable', async () => {
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      setCurrentProject(18);
      await request(mountApp()).get('/v1/mail/agents');
      await request(mountApp()).get('/v1/mail/agents');

      const driftLogs = errSpy.mock.calls
        .map((c) => String(c[0]))
        .filter((m) => m.includes('CURRENT-PROJECT DRIFT DETECTED'));
      expect(driftLogs).toHaveLength(0);
    } finally {
      errSpy.mockRestore();
    }
  });
});
