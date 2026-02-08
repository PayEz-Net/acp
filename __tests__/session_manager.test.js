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
    manager = new SessionManager({ storageMode: 'physical', vibesqlUrl: 'http://localhost:5173', acpDataDir: '.acp-test' });
  });

  afterEach(() => {
    delete global.fetch;
  });

  test('load returns null when session not found anywhere', async () => {
    const result = await manager.load('NonExistent');
    expect(result).toBeNull();
  });

  test('load returns session from primary storage with vibesql source', async () => {
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

  test('save returns savedTo with both targets on success', async () => {
    global.fetch = jest.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ success: true, rows: [], rowCount: 0 }),
    }));

    const result = await manager.save(mockSession);
    expect(result.savedTo).toContain('vibesql');
    expect(result.savedTo).toContain('file');
    expect(global.fetch).toHaveBeenCalled();
  });

  test('save returns savedTo with only file when primary fails', async () => {
    global.fetch = jest.fn(async () => { throw new Error('network error'); });

    const result = await manager.save(mockSession);
    expect(result.savedTo).toEqual(['file']);
    expect(result.savedTo).not.toContain('vibesql');
  });

  test('delete calls primary storage', async () => {
    global.fetch = jest.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ success: true, rows: [], rowCount: 0 }),
    }));

    await manager.delete('TestAgent');
    expect(global.fetch).toHaveBeenCalled();
  });

  test('list returns sessions from primary storage', async () => {
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

  test('list falls back to file backup when primary fails', async () => {
    global.fetch = jest.fn(async () => { throw new Error('connection refused'); });

    const result = await manager.list();
    expect(Array.isArray(result)).toBe(true);
  });

  test('load falls back gracefully when primary storage throws', async () => {
    global.fetch = jest.fn(async () => { throw new Error('network error'); });

    const result = await manager.load('TestAgent');
    expect(result).toBeNull();
  });

  test('exposes storage adapter via getter', () => {
    expect(manager.storage).toBeDefined();
  });
});
