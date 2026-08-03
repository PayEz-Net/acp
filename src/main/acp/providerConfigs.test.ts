import { describe, it, expect } from 'vitest';
import {
  claudeModelArgs,
  CLAUDE_MODELS,
  ModelNotRecognizedError,
} from './providerConfigs';

describe('claudeModelArgs', () => {
  it('returns [] when no override (inherit Claude Code default)', () => {
    expect(claudeModelArgs(null)).toEqual([]);
    expect(claudeModelArgs(undefined)).toEqual([]);
    expect(claudeModelArgs('')).toEqual([]);
  });

  it('appends --model <alias> for every recognized claude model', () => {
    for (const m of CLAUDE_MODELS) {
      expect(claudeModelArgs(m)).toEqual(['--model', m]);
    }
  });

  it('offers haiku so a background agent (e.g. NextPert) can run fast', () => {
    expect(CLAUDE_MODELS.has('haiku')).toBe(true);
    expect(claudeModelArgs('haiku')).toEqual(['--model', 'haiku']);
  });

  it('ignores an unrecognized/typo model (spawns default) instead of failing the spawn', () => {
    expect(claudeModelArgs('haiku-typo')).toEqual([]);
    expect(claudeModelArgs('opus-4-8')).toEqual([]);
  });

  it('ignores a stale kimi id on the claude path (cross-runtime mismatch), matching the TUI path', () => {
    // A kimi placement flipped to claude keeps its old model_override; base
    // IGNORES it and spawns default rather than taking the agent down.
    expect(claudeModelArgs('k3')).toEqual([]);
    expect(claudeModelArgs('kimi-for-coding-highspeed')).toEqual([]);
  });

  it('warns (does not throw) when it ignores a non-claude model', () => {
    let warned = '';
    expect(claudeModelArgs('k3', (m) => { warned = m; })).toEqual([]);
    expect(warned).toContain('k3');
    expect(warned).toContain('haiku');
  });
});

describe('ModelNotRecognizedError — kimi default is unchanged', () => {
  it('still reports the kimi provider + kimi known set by default', () => {
    const e = new ModelNotRecognizedError('kimi-turbo-typo');
    expect(e.message).toContain('kimi');
    expect(e.message).toContain('k3');
  });
});
