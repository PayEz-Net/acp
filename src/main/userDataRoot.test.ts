import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import * as fsSync from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  resolveRoots,
  migrateLegacyRoot,
  ensureSingleUserDataRoot,
  type AppLike,
} from './userDataRoot';

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'userdata-root-'));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

const ACP = (): string => path.join(dir, 'ACP');
const LEGACY = (): string => path.join(dir, 'agent-collaboration-platform');

async function writeFile(root: string, rel: string, content: string, mtime?: Date): Promise<void> {
  const p = path.join(root, rel);
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, content);
  if (mtime) {
    // Force an exact mtime so newer-wins is deterministic in the test.
    const t = mtime.getTime() / 1000;
    const fd = await fs.open(p, 'r+');
    try {
      await fd.truncate(content.length);
    } finally {
      await fd.close();
    }
    fsSync.utimesSync(p, t, t);
  }
}

function mockApp(userData: string): AppLike & { setCalls: string[] } {
  const state = { userData, setCalls: [] as string[] };
  return {
    setCalls: state.setCalls,
    getPath: (name: 'appData' | 'userData') => (name === 'appData' ? dir : state.userData),
    setPath: (_name: 'userData', p: string) => {
      state.setCalls.push(p);
      state.userData = p;
    },
  };
}

describe('resolveRoots', () => {
  it('names ACP desired and agent-collaboration-platform legacy under appData', () => {
    const { desiredRoot, legacyRoot } = resolveRoots(dir);
    expect(desiredRoot).toBe(ACP());
    expect(legacyRoot).toBe(LEGACY());
  });
});

describe('migrateLegacyRoot', () => {
  it('is a no-op when no legacy root exists', async () => {
    await writeFile(ACP(), 'auth.json', 'live');
    const r = migrateLegacyRoot(dir);
    expect(r.removedLegacyRoot).toBe(false);
    expect(r.moved).toEqual([]);
    await expect(fs.readFile(path.join(ACP(), 'auth.json'), 'utf8')).resolves.toBe('live');
  });

  it('whole-root renames legacy -> ACP when ACP does not exist', async () => {
    await writeFile(LEGACY(), 'auth.json', 'live-token');
    await writeFile(LEGACY(), path.join('agent-output-spill', 'a.json'), 'spill');
    const r = migrateLegacyRoot(dir);
    expect(r.removedLegacyRoot).toBe(true);
    expect(r.moved.sort()).toEqual(['auth.json', path.join('agent-output-spill', 'a.json')].sort());
    await expect(fs.readFile(path.join(ACP(), 'auth.json'), 'utf8')).resolves.toBe('live-token');
    await expect(fs.readFile(path.join(ACP(), 'agent-output-spill', 'a.json'), 'utf8')).resolves.toBe('spill');
    expect(fsSync.existsSync(LEGACY())).toBe(false);
  });

  it('both roots populated: legacy wins when strictly newer, existing kept otherwise, legacy root removed', async () => {
    const older = new Date('2026-04-28T04:21:35Z');
    const newer = new Date('2026-08-14T12:16:00Z');
    // auth.json: legacy NEWER (the live queue's twin) -> legacy must win
    await writeFile(ACP(), 'auth.json', 'stale-token', older);
    await writeFile(LEGACY(), 'auth.json', 'live-token', newer);
    // keychain.json: ACP newer -> keep ACP, legacy copy discarded
    await writeFile(ACP(), 'keychain.json', 'acp-newer', newer);
    await writeFile(LEGACY(), 'keychain.json', 'legacy-older', older);
    // spill queue: only in legacy -> moves regardless of age
    await writeFile(LEGACY(), path.join('agent-output-spill', 'b.json'), 'queued', older);

    const r = migrateLegacyRoot(dir);
    expect(r.removedLegacyRoot).toBe(true);
    expect(r.moved.sort()).toEqual(['auth.json', path.join('agent-output-spill', 'b.json')].sort());
    expect(r.keptExisting).toEqual(['keychain.json']);

    await expect(fs.readFile(path.join(ACP(), 'auth.json'), 'utf8')).resolves.toBe('live-token');
    await expect(fs.readFile(path.join(ACP(), 'keychain.json'), 'utf8')).resolves.toBe('acp-newer');
    await expect(fs.readFile(path.join(ACP(), 'agent-output-spill', 'b.json'), 'utf8')).resolves.toBe('queued');
    expect(fsSync.existsSync(LEGACY())).toBe(false);
  });
});

describe('ensureSingleUserDataRoot', () => {
  it('repoints a dev-named userData to the ACP root', () => {
    const app = mockApp(LEGACY());
    const r = ensureSingleUserDataRoot(app);
    expect(r.repointed).toBe(true);
    expect(app.setCalls).toEqual([ACP()]);
    expect(app.getPath('userData')).toBe(ACP());
    expect(r.lines[0]).toContain('userData root resolved');
  });

  it('leaves an already-canonical userData alone', () => {
    const app = mockApp(ACP());
    const r = ensureSingleUserDataRoot(app);
    expect(r.repointed).toBe(false);
    expect(app.setCalls).toEqual([]);
  });

  it('never throws when the filesystem misbehaves, and reports the failure', () => {
    const app = mockApp(LEGACY());
    // FILE in legacy where a DIRECTORY exists in desired: every move strategy
    // throws on that entry (rm of a dir without recursive, then EISDIR copy),
    // so the module must degrade and log rather than crash boot.
    fsSync.mkdirSync(ACP(), { recursive: true });
    fsSync.mkdirSync(path.join(ACP(), 'agent-output-spill'));
    fsSync.mkdirSync(LEGACY());
    const f = path.join(LEGACY(), 'agent-output-spill');
    fsSync.writeFileSync(f, 'a file, not a dir');
    // Strictly newer than the desired dir so the move is actually attempted.
    const t = new Date('2027-01-01T00:00:00Z').getTime() / 1000;
    fsSync.utimesSync(f, t, t);
    const r = ensureSingleUserDataRoot(app);
    expect(r.lines.some((l) => l.includes('FAILED'))).toBe(true);
  });
});
