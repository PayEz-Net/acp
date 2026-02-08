import { jest } from '@jest/globals';
import { VibeApiClient } from '../storage/vibe_api_client.js';

const testConfig = {
  vibeApiUrl: 'http://localhost:32786',
  vibeClientId: 1,
  vibeAuthMode: 'hmac',
  vibeSigningKey: Buffer.from('test-key').toString('base64'),
  vibeTokenCmd: 'echo {}',
  vibeTokenRefreshS: 300,
};

describe('VibeApiClient', () => {
  let fetchCalls;

  beforeEach(() => {
    fetchCalls = [];
    global.fetch = jest.fn(async (url, opts) => {
      fetchCalls.push({ url, opts });
      return {
        ok: true,
        status: 200,
        json: async () => ({ data: [], rows: [] }),
      };
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
    delete global.fetch;
  });

  test('getSession returns null when no rows', async () => {
    const client = new VibeApiClient(testConfig);
    const result = await client.getSession('TestAgent');
    expect(result).toBeNull();
  });

  test('getSession returns session from doc', async () => {
    global.fetch = jest.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        data: [{
          id: 1,
          data: {
            session_id: 'sess_v1',
            agent_name: 'VibeAgent',
            character: 'forge',
            custom_functions: {},
            preferences: {},
            memory: {},
            created_at: '2026-01-01T00:00:00.000Z',
            updated_at: '2026-01-01T00:00:00.000Z',
            version: 1,
          },
        }],
      }),
    }));

    const client = new VibeApiClient(testConfig);
    const result = await client.getSession('VibeAgent');
    expect(result.agentName).toBe('VibeAgent');
    expect(result.sessionId).toBe('sess_v1');
    expect(result.character).toBe('forge');
  });

  test('_docId is non-enumerable on session objects', async () => {
    global.fetch = jest.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        data: [{
          id: 42,
          data: {
            session_id: 'sess_v1',
            agent_name: 'Agent',
            version: 1,
          },
        }],
      }),
    }));

    const client = new VibeApiClient(testConfig);
    const result = await client.getSession('Agent');
    expect(result._docId).toBe(42);
    expect(Object.keys(result)).not.toContain('_docId');
    expect(JSON.parse(JSON.stringify(result))._docId).toBeUndefined();
  });

  test('listSessions calls GET on documents endpoint', async () => {
    const client = new VibeApiClient(testConfig);
    const result = await client.listSessions();
    expect(result).toEqual([]);
    expect(global.fetch).toHaveBeenCalledTimes(1);
    const url = global.fetch.mock.calls[0][0];
    expect(url).toContain('/v1/schemas/acp/documents/agent_sessions');
  });

  test('_apiCall uses instance config URL', async () => {
    const customConfig = { ...testConfig, vibeApiUrl: 'http://custom-host:8888' };
    const client = new VibeApiClient(customConfig);
    await client.listSessions();
    const url = global.fetch.mock.calls[0][0];
    expect(url).toStartWith('http://custom-host:8888');
  });

  test('deleteSession queries then deletes by doc id', async () => {
    let callCount = 0;
    global.fetch = jest.fn(async () => {
      callCount++;
      if (callCount === 1) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            data: [{ id: 42, data: { session_id: 's', agent_name: 'X', version: 1 } }],
          }),
        };
      }
      return { ok: true, status: 200, json: async () => ({}) };
    });

    const client = new VibeApiClient(testConfig);
    await client.deleteSession('X');
    expect(global.fetch).toHaveBeenCalledTimes(2);
    const deleteCall = global.fetch.mock.calls[1];
    expect(deleteCall[1].method).toBe('DELETE');
    expect(deleteCall[0]).toContain('/42');
  });

  test('HMAC headers are set in hmac mode', async () => {
    const client = new VibeApiClient(testConfig);
    await client.listSessions();
    const headers = global.fetch.mock.calls[0][1].headers;
    expect(headers['X-Vibe-Client-Id']).toBe('1');
    const ts = parseInt(headers['X-Vibe-Timestamp'], 10);
    expect(ts).toBeGreaterThan(1700000000);
    expect(ts).toBeLessThanOrEqual(Math.floor(Date.now() / 1000));
    expect(typeof headers['X-Vibe-Signature']).toBe('string');
    expect(headers['X-Vibe-Signature'].length).toBeGreaterThan(0);
    expect(headers['Authorization']).toBeUndefined();
  });

  test('bearer headers are set in bearer mode', async () => {
    const bearerConfig = { ...testConfig, vibeAuthMode: 'bearer', vibeTokenCmd: 'echo {"access_token":"test-jwt-123"}' };
    const client = new VibeApiClient(bearerConfig);
    await client.listSessions();
    const headers = global.fetch.mock.calls[0][1].headers;
    expect(headers['Authorization']).toBe('Bearer test-jwt-123');
    expect(headers['X-Vibe-Client-Id']).toBe('1');
    expect(headers['X-Vibe-Signature']).toBeUndefined();
  });

  test('throws on non-ok response', async () => {
    global.fetch = jest.fn(async () => ({
      ok: false,
      status: 500,
      json: async () => ({ message: 'server error' }),
    }));

    const client = new VibeApiClient(testConfig);
    await expect(client.listSessions()).rejects.toThrow('server error');
  });
});

expect.extend({
  toStartWith(received, prefix) {
    const pass = typeof received === 'string' && received.startsWith(prefix);
    return {
      pass,
      message: () => `expected ${received} to start with ${prefix}`,
    };
  },
});
