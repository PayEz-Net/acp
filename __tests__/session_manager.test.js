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
    manager = new SessionManager({ vibesqlUrl: 'http://localhost:5173' });
  });

  test('load returns null when session not found', async () => {
    const result = await manager.load('NonExistent');
    expect(result).toBeNull();
  });

  test('load returns session from memory with correct source', async () => {
    await manager.save(mockSession);
    const result = await manager.load('TestAgent');
    expect(result).not.toBeNull();
    expect(result.source).toBe('memory');
    expect(result.session.agentName).toBe('TestAgent');
  });

  test('save returns savedTo with memory', async () => {
    const result = await manager.save(mockSession);
    expect(result.savedTo).toContain('memory');
  });

  test('delete removes session from memory', async () => {
    await manager.save(mockSession);
    expect(await manager.load('TestAgent')).not.toBeNull();
    await manager.delete('TestAgent');
    expect(await manager.load('TestAgent')).toBeNull();
  });

  test('list returns sessions from memory', async () => {
    await manager.save(mockSession);
    const result = await manager.list();
    expect(result).toHaveLength(1);
    expect(result[0].agentName).toBe('TestAgent');
  });

  test('exposes storage adapter via getter', () => {
    expect(manager.storage).toBeDefined();
  });

  test('getAgentRegistration returns registered agent', async () => {
    const result = await manager.getAgentRegistration('agent:DotNetPert');
    expect(result).not.toBeNull();
    expect(result.name).toBe('DotNetPert');
  });

  test('getAgentRegistration returns null for unknown agent', async () => {
    const result = await manager.getAgentRegistration('agent:Unknown');
    expect(result).toBeNull();
  });
});
