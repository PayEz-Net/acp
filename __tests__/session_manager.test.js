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

  // The agent roster migrated from an in-memory registry to CLOUD hydration. A fresh
  // manager with no hydrated roster CANNOT report "not registered" — it must throw
  // (it can't distinguish an unknown agent from a never-loaded roster). Honest-fail,
  // not a silent null. (Updated from the stale pre-migration in-memory expectations.)
  test('getAgentRegistration throws when the roster is not hydrated (no session)', async () => {
    await expect(manager.getAgentRegistration('agent:DotNetPert'))
      .rejects.toThrow(/roster could not be resolved/i);
  });

  test('getAgentRegistration throws for any name when roster unhydrated (never a silent null)', async () => {
    await expect(manager.getAgentRegistration('agent:Unknown'))
      .rejects.toThrow(/roster could not be resolved/i);
  });

  // WO 8196 lane B: the in-memory document stub was RIPPED OUT. Documents are now
  // CLOUD-backed (project-scoped /v1/projects/:id/documents) and HONEST-FAIL — every
  // method requires a project_id and throws when the cloud is unreachable (no session
  // in this test). NEVER fakes success / persists to a Map. These tests assert that
  // contract (the lie is gone), not the old in-memory behavior.
  describe('documents (cloud-backed, honest-fail)', () => {
    test('createDocument requires project_id (project-scoped)', async () => {
      await expect(manager.createDocument({ title: 'X', content_md: 'y' }))
        .rejects.toThrow(/projectId is required/i);
    });

    test('listDocuments requires project_id', async () => {
      await expect(manager.listDocuments())
        .rejects.toThrow(/projectId is required/i);
    });

    test('getDocument requires project_id', async () => {
      await expect(manager.getDocument(1))
        .rejects.toThrow(/projectId is required/i);
    });

    test('createDocument never fakes success — throws when the cloud is unreachable (no in-memory)', async () => {
      await expect(manager.createDocument({ project_id: 14, title: 'X', content_md: 'y' }))
        .rejects.toThrow();
    });

    test('listDocuments never returns a silent empty — throws when the cloud is unreachable', async () => {
      await expect(manager.listDocuments({ project_id: 14 }))
        .rejects.toThrow();
    });
  });

  // BAPert 8032 DEFENSE lane — the developer->active-project->tenant flicker
  // must NOT be able to strand the desktop/kanban at 0. A transient null/empty
  // from a raced resolve must never be memoized (no TTL poison): the next call
  // re-resolves instead of serving the poisoned value for the whole TTL.
  describe('project-scope flicker hardening (no TTL poison)', () => {
    const stored = (pid) => ({ status: 200, body: { data: { current_project_state: 'stored', current_project_id: pid } } });
    const unset = () => ({ status: 200, body: { data: { current_project_state: 'unset' } } });
    const listOf = (n) => ({ status: 200, body: { data: { projects: Array.from({ length: n }, (_, i) => ({ id: i + 1, name: `p${i + 1}` })) } } });

    test('getActiveProjectId: a raced null is NOT memoized — next call re-resolves to the real pid', async () => {
      const responses = [unset(), stored(42)];
      manager._cloudGet = jest.fn(async () => responses.shift());

      // First resolve races to null/unset — returned truthfully, NOT cached.
      expect(await manager.getActiveProjectId()).toBeNull();
      // Without the fix, the null would be served from cache here (poison).
      // With the fix, the cloud is hit again and the real pid lands.
      expect(await manager.getActiveProjectId()).toBe(42);
      expect(manager._cloudGet).toHaveBeenCalledTimes(2);
    });

    test('getActiveProjectId: a real pid IS memoized (single cloud call within TTL)', async () => {
      manager._cloudGet = jest.fn(async () => stored(7));
      expect(await manager.getActiveProjectId()).toBe(7);
      expect(await manager.getActiveProjectId()).toBe(7);
      expect(manager._cloudGet).toHaveBeenCalledTimes(1); // second served from cache
    });

    test('listProjects: a raced empty [] is NOT memoized — next call re-resolves to the real list', async () => {
      const responses = [listOf(0), listOf(6)];
      manager._cloudGet = jest.fn(async () => responses.shift());

      expect(await manager.listProjects()).toHaveLength(0);
      // The empty [] must NOT have armed the TTL — re-resolve gets the real 6.
      expect(await manager.listProjects()).toHaveLength(6);
      expect(manager._cloudGet).toHaveBeenCalledTimes(2);
    });

    test('listProjects: a non-empty list IS memoized (single cloud call within TTL)', async () => {
      manager._cloudGet = jest.fn(async () => listOf(6));
      expect(await manager.listProjects()).toHaveLength(6);
      expect(await manager.listProjects()).toHaveLength(6);
      expect(manager._cloudGet).toHaveBeenCalledTimes(1);
    });
  });
});
