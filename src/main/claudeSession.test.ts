import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  deriveClaudeSessionId,
  claudeProjectSlug,
  claudeSessionFile,
  claudeSessionExists,
} from './claudeSession';

describe('deriveClaudeSessionId', () => {
  it('is STABLE across calls — the whole point, or a restart never resumes', () => {
    const a = deriveClaudeSessionId('QAPert', 284);
    const b = deriveClaudeSessionId('QAPert', 284);
    expect(a).toBe(b);
  });

  it('is a well-formed v5-shaped UUID (--session-id rejects anything else)', () => {
    const id = deriveClaudeSessionId('QAPert', 284);
    expect(id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it('differs per agent', () => {
    expect(deriveClaudeSessionId('QAPert', 284)).not.toBe(
      deriveClaudeSessionId('BAPert', 284),
    );
  });

  it('differs per PROJECT for the same agent — per-placement, like the other overrides', () => {
    expect(deriveClaudeSessionId('QAPert', 284)).not.toBe(
      deriveClaudeSessionId('QAPert', 999),
    );
  });

  it('handles an absent project without colliding with a real one', () => {
    const none = deriveClaudeSessionId('QAPert', undefined);
    expect(none).toMatch(/^[0-9a-f]{8}-/);
    expect(none).not.toBe(deriveClaudeSessionId('QAPert', 284));
  });
});

describe('claudeProjectSlug', () => {
  it('matches the observed on-disk form for a Windows path', () => {
    // `E:\Repos` is stored as `E--Repos`: colon and separator each become a dash.
    expect(claudeProjectSlug('E:\\Repos')).toBe('E--Repos');
  });

  it('collapses posix separators too', () => {
    expect(claudeProjectSlug('/home/jon/repos')).toBe('-home-jon-repos');
  });
});

describe('claudeSessionExists', () => {
  let home: string;
  let realUserProfile: string | undefined;
  let realHomeEnv: string | undefined;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-home-'));
    // Save BOTH and restore BOTH. Restoring only one leaked a fake home into
    // sibling suites, so this test passed alone and failed in a full run.
    realUserProfile = process.env.USERPROFILE;
    realHomeEnv = process.env.HOME;
    process.env.USERPROFILE = home;
    process.env.HOME = home;
  });

  afterEach(() => {
    if (realUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = realUserProfile;
    if (realHomeEnv === undefined) delete process.env.HOME;
    else process.env.HOME = realHomeEnv;
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('is FALSE when no transcript exists — must create, not resume', () => {
    expect(claudeSessionExists('E:\\Repos', 'abc')).toBe(false);
  });

  it('is TRUE for a non-empty transcript at the derived path', () => {
    const f = claudeSessionFile('E:\\Repos', 'abc');
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, '{"type":"x"}\n');
    expect(claudeSessionExists('E:\\Repos', 'abc')).toBe(true);
  });

  it('is FALSE for an EMPTY transcript', () => {
    // A zero-byte file is a half-created session. Resuming it is not obviously
    // safe and the cost of guessing wrong is a dead pane, so treat it as absent.
    const f = claudeSessionFile('E:\\Repos', 'abc');
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, '');
    expect(claudeSessionExists('E:\\Repos', 'abc')).toBe(false);
  });

  it('is FALSE for a different cwd — sessions are per-directory', () => {
    const f = claudeSessionFile('E:\\Repos', 'abc');
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, '{"type":"x"}\n');
    expect(claudeSessionExists('E:\\Other', 'abc')).toBe(false);
  });
});
