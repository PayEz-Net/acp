import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import express from 'express';
import http from 'http';
import type { AddressInfo } from 'net';
import terminalReplayRoutes from '../terminalReplay.js';
import { setSession, clearSession } from '../../auth/tokenManager.js';
import type { Config } from '../../../config.js';

function request(
  baseUrl: string,
  path: string,
): Promise<{ status: number; body: unknown; headers?: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const req = http.get(`${baseUrl}${path}`, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk.toString(); });
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode ?? 0, body: JSON.parse(data), headers: res.headers });
        } catch {
          resolve({ status: res.statusCode ?? 0, body: data, headers: res.headers });
        }
      });
    });
    req.on('error', reject);
  });
}

function makeFakeJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${header}.${body}.`;
}

function makeConfig(vibeApiUrl: string): Config {
  return {
    idpUrl: 'http://127.0.0.1:9999',
    vibeApiUrl,
    acpLocalSecret: 'test-secret',
    nodeEnv: 'test',
    port: 0,
    host: '127.0.0.1',
    acpCallbackPort: 9998,
    acpAgents: [],
    corsOrigins: [],
    logLevel: 'error',
    vibeConnectionString: '',
    enableContractors: false,
    externalApiUrl: '',
  } as Config;
}

describe('terminalReplayRoutes', () => {
  let app: express.Express;
  let server: http.Server;
  let baseUrl: string;
  let backend: http.Server;
  let backendUrl: string;
  let backendHistory: unknown[];
  let fetchSpy: jest.SpyInstance | undefined;
  let capturedOrder: string | null;

  beforeEach((done) => {
    backendHistory = [];
    capturedOrder = null;
    backend = http.createServer((req, res) => {
      if (req.url?.startsWith('/v1/agent-output/history')) {
        const url = new URL(req.url, `http://127.0.0.1`);
        const projectId = url.searchParams.get('projectId');
        const agents = url.searchParams.get('agents');
        const sessionId = url.searchParams.get('sessionId');
        const cursor = url.searchParams.get('cursor');
        const limit = Number(url.searchParams.get('limit') || '500');
        capturedOrder = url.searchParams.get('order');

        let lines = backendHistory as Array<Record<string, unknown>>;
        if (projectId) {
          lines = lines.filter((l) => String(l.project_id) === projectId);
        }
        if (agents) {
          const set = new Set(agents.split(','));
          lines = lines.filter((l) => set.has(String(l.agent)));
        }
        if (sessionId) {
          lines = lines.filter((l) => String(l.session_id) === sessionId);
        }

        // Simple OFFSET cursor: base64 of offset integer.
        const offset = cursor ? Number(Buffer.from(cursor, 'base64').toString('utf8')) : 0;
        const page = lines.slice(offset, offset + limit);
        const nextOffset = offset + page.length;
        const nextCursor = nextOffset < lines.length ? Buffer.from(String(nextOffset)).toString('base64') : undefined;

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: true,
          data: { lines: page, next_cursor: nextCursor },
        }));
        return;
      }
      res.writeHead(404);
      res.end(JSON.stringify({ success: false }));
    });

    backend.listen(0, () => {
      const port = (backend.address() as AddressInfo).port;
      backendUrl = `http://127.0.0.1:${port}`;

      app = express();
      app.use('/v1/terminal', terminalReplayRoutes(makeConfig(backendUrl)));
      server = app.listen(0, () => {
        const appPort = (server.address() as AddressInfo).port;
        baseUrl = `http://127.0.0.1:${appPort}`;

        const token = makeFakeJwt({ exp: 9999999999, client_id: 'test-client' });
        setSession({
          accessToken: token,
          refreshToken: 'refresh',
          expiresAt: new Date('2099-01-01T00:00:00.000Z'),
          userId: 'user-1',
          email: 'test@example.com',
        });

        done();
      });
    });
  });

  afterEach((done) => {
    clearSession();
    fetchSpy?.mockRestore();
    server.close(() => {
      backend.close(() => done());
    });
  });

  it('rejects missing project_id', async () => {
    const { status, body } = await request(baseUrl, '/v1/terminal/replay');
    expect(status).toBe(400);
    expect((body as any).success).toBe(false);
  });

  it('rejects invalid project_id', async () => {
    const { status, body } = await request(baseUrl, '/v1/terminal/replay?project_id=abc');
    expect(status).toBe(400);
    expect((body as any).success).toBe(false);
  });

  it('returns paginated replay lines from backend history', async () => {
    backendHistory = [
      { project_id: '1', session_id: 's1', agent: 'BAPert', terminal_id: 't1', provider: 'claude', line: 'line-0', ts: '2026-07-03T10:00:00.000Z' },
      { project_id: '1', session_id: 's1', agent: 'BAPert', terminal_id: 't1', provider: 'claude', line: 'line-1', ts: '2026-07-03T10:00:01.000Z' },
      { project_id: '1', session_id: 's1', agent: 'BAPert', terminal_id: 't1', provider: 'claude', line: 'line-2', ts: '2026-07-03T10:00:02.000Z' },
    ];

    const { status, body } = await request(baseUrl, '/v1/terminal/replay?project_id=1&limit=2');
    expect(status).toBe(200);
    const data = (body as any).data;
    expect(data.lines).toHaveLength(2);
    expect(data.next_cursor).toBeDefined();
  });

  it('filters by agent and session', async () => {
    backendHistory = [
      { project_id: '1', session_id: 's1', agent: 'BAPert', terminal_id: 't1', provider: 'claude', line: 'a', ts: '2026-07-03T10:00:00.000Z' },
      { project_id: '1', session_id: 's2', agent: 'DotNetPert', terminal_id: 't2', provider: 'claude', line: 'b', ts: '2026-07-03T10:00:01.000Z' },
    ];

    const { status, body } = await request(baseUrl, '/v1/terminal/replay?project_id=1&agents=DotNetPert&session_id=s2');
    expect(status).toBe(200);
    const data = (body as any).data;
    expect(data.lines).toHaveLength(1);
    expect(data.lines[0].line).toBe('b');
  });

  it('lists sessions aggregated from history', async () => {
    backendHistory = [
      { project_id: '1', session_id: 's1', agent: 'BAPert', terminal_id: 't1', provider: 'claude', line: 'a', ts: '2026-07-03T10:00:00.000Z' },
      { project_id: '1', session_id: 's2', agent: 'DotNetPert', terminal_id: 't2', provider: 'claude', line: 'b', ts: '2026-07-03T10:00:01.000Z' },
    ];

    const { status, body } = await request(baseUrl, '/v1/terminal/sessions?project_id=1');
    expect(status).toBe(200);
    const sessions = (body as any).data.sessions;
    expect(sessions).toHaveLength(2);
  });

  it('exports ndjson aggregated from history', async () => {
    backendHistory = [
      { project_id: '1', session_id: 's1', agent: 'BAPert', terminal_id: 't1', provider: 'claude', line: 'a', ts: '2026-07-03T10:00:00.000Z' },
      { project_id: '1', session_id: 's2', agent: 'DotNetPert', terminal_id: 't2', provider: 'claude', line: 'b', ts: '2026-07-03T10:00:01.000Z' },
    ];

    const { status, body, headers } = await request(baseUrl, '/v1/terminal/export?project_id=1&format=ndjson');
    expect(status).toBe(200);
    expect(headers?.['content-type']).toBe('application/x-ndjson');
    const lines = (body as string).split('\n').filter(Boolean);
    expect(lines).toHaveLength(2);
  });

  it('returns 401 when no cloud session is available', async () => {
    clearSession();
    const { status, body } = await request(baseUrl, '/v1/terminal/replay?project_id=1');
    expect(status).toBe(401);
    expect((body as any).success).toBe(false);
  });

  // ── 117048: tail access + bounded aggregation ──────────────────────────────

  it('forwards order=desc to the backend (tail access)', async () => {
    backendHistory = [
      { project_id: '1', session_id: 's1', agent: 'BAPert', terminal_id: 't1', provider: 'claude', line: 'newest', ts: '2026-08-07T09:00:00.000Z' },
    ];

    const { status, body } = await request(baseUrl, '/v1/terminal/replay?project_id=1&order=desc&limit=1');
    expect(status).toBe(200);
    expect(capturedOrder).toBe('desc');
    expect((body as any).data.lines).toHaveLength(1);
  });

  it('omits the order param when not requested (default ASC contract unchanged)', async () => {
    backendHistory = [];
    await request(baseUrl, '/v1/terminal/replay?project_id=1');
    expect(capturedOrder).toBeNull();
  });

  it('sessions flags truncation instead of dying when history exceeds the page cap', async () => {
    // 20 pages x 5000 lines = the cap; one more line forces a 21st page -> truncated.
    const big: unknown[] = [];
    for (let i = 0; i < 100001; i += 1) {
      big.push({ project_id: '1', session_id: 's1', agent: 'BAPert', terminal_id: 't1', provider: 'claude', line: `l${i}`, ts: `2026-08-01T00:${String(Math.floor(i / 60) % 60).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}.000Z` });
    }
    backendHistory = big;

    const { status, body } = await request(baseUrl, '/v1/terminal/sessions?project_id=1');
    expect(status).toBe(200);
    expect((body as any).data.truncated).toBe(true);
    expect((body as any).data.sessions.length).toBeGreaterThan(0);
  });

  it('sessions reports truncated=false on a bounded history', async () => {
    backendHistory = [
      { project_id: '1', session_id: 's1', agent: 'BAPert', terminal_id: 't1', provider: 'claude', line: 'a', ts: '2026-07-03T10:00:00.000Z' },
    ];

    const { status, body } = await request(baseUrl, '/v1/terminal/sessions?project_id=1');
    expect(status).toBe(200);
    expect((body as any).data.truncated).toBe(false);
  });
});
