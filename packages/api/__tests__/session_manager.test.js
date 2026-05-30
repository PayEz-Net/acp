import { jest } from '@jest/globals';
import { SessionManager } from '../agents/session_manager.js';

const mockSession = {
  sessionId: 'sess_test',
  agentName: 'TestAgent',
  character: 'sage',
  customFunctions: {},
  preferences: {},
  memory: {},
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  version: 1,
};

describe('SessionManager', () => {
  let manager;

  beforeEach(() => {
    global.fetch = jest.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ success: true, rows: [], rowCount: 0 }),
    }));
    manager = new SessionManager({ vibesqlUrl: 'http://localhost:5173' });
  });

  afterEach(() => {
    delete global.fetch;
  });

  test('load returns null when session not found', async () => {
    const result = await manager.load('NonExistent');
    expect(result).toBeNull();
  });

  test('load returns session from vibesql with correct source', async () => {
    global.fetch = jest.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        success: true,
        rows: [{
          session_id: 'sess_test',
          agent_name: 'TestAgent',
          character: 'sage',
          custom_functions: {},
          preferences: {},
          memory: {},
          created_at: '2026-01-01T00:00:00.000Z',
          updated_at: '2026-01-01T00:00:00.000Z',
          version: 1,
        }],
        rowCount: 1,
      }),
    }));

    const result = await manager.load('TestAgent');
    expect(result).not.toBeNull();
    expect(result.source).toBe('vibesql');
    expect(result.session.agentName).toBe('TestAgent');
  });

  test('save returns savedTo with vibesql', async () => {
    global.fetch = jest.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ success: true, rows: [], rowCount: 0 }),
    }));

    const result = await manager.save(mockSession);
    expect(result.savedTo).toContain('vibesql');
    expect(global.fetch).toHaveBeenCalled();
  });

  test('save throws when vibesql fails (no fallback)', async () => {
    global.fetch = jest.fn(async () => { throw new Error('network error'); });

    await expect(manager.save(mockSession)).rejects.toThrow('network error');
  });

  test('delete calls vibesql storage', async () => {
    global.fetch = jest.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ success: true, rows: [], rowCount: 0 }),
    }));

    await manager.delete('TestAgent');
    expect(global.fetch).toHaveBeenCalled();
  });

  test('list returns sessions from vibesql', async () => {
    global.fetch = jest.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        success: true,
        rows: [
          { session_id: 's1', agent_name: 'A1', character: null, custom_functions: {}, preferences: {}, memory: {}, created_at: 'x', updated_at: 'x', version: 1 },
        ],
        rowCount: 1,
      }),
    }));

    const result = await manager.list();
    expect(result).toHaveLength(1);
    expect(result[0].agentName).toBe('A1');
  });

  test('list throws when vibesql fails (no fallback)', async () => {
    global.fetch = jest.fn(async () => { throw new Error('connection refused'); });

    await expect(manager.list()).rejects.toThrow('connection refused');
  });

  test('load throws when vibesql fails (no fallback)', async () => {
    global.fetch = jest.fn(async () => { throw new Error('network error'); });

    await expect(manager.load('TestAgent')).rejects.toThrow('network error');
  });

  test('exposes storage adapter via getter', () => {
    expect(manager.storage).toBeDefined();
  });
});
