import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  readSession,
  writeSession,
  deleteSession,
  listSessions,
  setConfig,
} from '../storage/file_backup.js';

let tmpDir;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'acp-test-'));
  setConfig({ acpDataDir: tmpDir });
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

const mockSession = {
  sessionId: 'sess_test123',
  agentName: 'TestAgent',
  character: 'sage',
  customFunctions: {},
  preferences: { autoCheck: true },
  memory: { tasks: [] },
  createdAt: '2026-02-07T00:00:00.000Z',
  updatedAt: '2026-02-07T00:00:00.000Z',
  version: 1,
};

describe('file_backup', () => {
  test('writeSession creates file and readSession returns it', async () => {
    await writeSession(mockSession);
    const result = await readSession('TestAgent');
    expect(result).toEqual(mockSession);
  });

  test('readSession returns null for nonexistent agent', async () => {
    const result = await readSession('NoSuchAgent');
    expect(result).toBeNull();
  });

  test('deleteSession removes the file', async () => {
    await writeSession(mockSession);
    await deleteSession('TestAgent');
    const result = await readSession('TestAgent');
    expect(result).toBeNull();
  });

  test('deleteSession is silent for nonexistent agent', async () => {
    await expect(deleteSession('NoSuchAgent')).resolves.toBeUndefined();
  });

  test('listSessions returns all sessions', async () => {
    await writeSession(mockSession);
    const session2 = { ...mockSession, sessionId: 'sess_test456', agentName: 'Agent2' };
    await writeSession(session2);
    const sessions = await listSessions();
    expect(sessions).toHaveLength(2);
    const names = sessions.map((s) => s.agentName).sort();
    expect(names).toEqual(['Agent2', 'TestAgent']);
  });

  test('listSessions returns empty array when no sessions', async () => {
    const sessions = await listSessions();
    expect(sessions).toEqual([]);
  });

  test('writeSession overwrites existing session', async () => {
    await writeSession(mockSession);
    const updated = { ...mockSession, version: 2, preferences: { autoCheck: false } };
    await writeSession(updated);
    const result = await readSession('TestAgent');
    expect(result.version).toBe(2);
    expect(result.preferences.autoCheck).toBe(false);
  });

  test('session file is valid JSON', async () => {
    await writeSession(mockSession);
    const raw = await readFile(join(tmpDir, 'TestAgent', 'session.json'), 'utf8');
    expect(() => JSON.parse(raw)).not.toThrow();
  });
});
