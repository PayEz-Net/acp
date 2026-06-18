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

  describe('documents', () => {
    test('createDocument returns doc with id and timestamps', async () => {
      const doc = await manager.createDocument({
        project_id: 14,
        title: 'Test Doc',
        content_md: '# Hello',
        type: 'context',
        version: '1.0',
      });
      expect(doc.id).toBeDefined();
      expect(doc.project_id).toBe(14);
      expect(doc.title).toBe('Test Doc');
      expect(doc.created_at).toBeDefined();
      expect(doc.updated_at).toBeDefined();
    });

    test('listDocuments returns all docs without filter', async () => {
      await manager.createDocument({ project_id: 14, title: 'A', content_md: 'a' });
      await manager.createDocument({ project_id: 15, title: 'B', content_md: 'b' });
      const docs = await manager.listDocuments();
      expect(docs.length).toBeGreaterThanOrEqual(2);
    });

    test('listDocuments filters by project_id', async () => {
      await manager.createDocument({ project_id: 99, title: 'Project 99', content_md: 'x' });
      const docs = await manager.listDocuments({ project_id: 99 });
      expect(docs).toHaveLength(1);
      expect(docs[0].title).toBe('Project 99');
    });

    test('getDocument returns doc by id', async () => {
      const created = await manager.createDocument({ title: 'Get Me', content_md: 'body' });
      const found = await manager.getDocument(created.id);
      expect(found).not.toBeNull();
      expect(found.title).toBe('Get Me');
    });

    test('getDocument returns null for missing id', async () => {
      const found = await manager.getDocument(99999);
      expect(found).toBeNull();
    });

    test('updateDocument patches fields', async () => {
      const created = await manager.createDocument({ title: 'Old', content_md: 'old' });
      const updated = await manager.updateDocument(created.id, { title: 'New' });
      expect(updated.title).toBe('New');
      expect(updated.content_md).toBe('old'); // unchanged
    });

    test('updateDocument returns null for missing id', async () => {
      const result = await manager.updateDocument(99999, { title: 'Nope' });
      expect(result).toBeNull();
    });

    test('deleteDocument removes doc', async () => {
      const created = await manager.createDocument({ title: 'Delete Me', content_md: 'x' });
      const deleted = await manager.deleteDocument(created.id);
      expect(deleted).toBe(true);
      expect(await manager.getDocument(created.id)).toBeNull();
    });

    test('deleteDocument returns false for missing id', async () => {
      const result = await manager.deleteDocument(99999);
      expect(result).toBe(false);
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
