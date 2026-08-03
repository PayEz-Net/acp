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

  it('throws loud on an unknown/typo model rather than spawning a fallback', () => {
    expect(() => claudeModelArgs('haiku-typo')).toThrow(ModelNotRecognizedError);
    expect(() => claudeModelArgs('opus-4-8')).toThrow(ModelNotRecognizedError);
  });

  it('rejects a kimi model on the claude path (cross-runtime mismatch)', () => {
    // A leftover kimi id must not silently pass through to claude.
    expect(() => claudeModelArgs('k3')).toThrow(ModelNotRecognizedError);
  });

  it('names the claude provider and the known set in the error', () => {
    try {
      claudeModelArgs('nope');
      throw new Error('expected claudeModelArgs to throw');
    } catch (e) {
      expect(e).toBeInstanceOf(ModelNotRecognizedError);
      expect((e as Error).message).toContain('claude');
      expect((e as Error).message).toContain('haiku');
    }
  });
});

describe('ModelNotRecognizedError — kimi default is unchanged', () => {
  it('still reports the kimi provider + kimi known set by default', () => {
    const e = new ModelNotRecognizedError('kimi-turbo-typo');
    expect(e.message).toContain('kimi');
    expect(e.message).toContain('k3');
  });
});
