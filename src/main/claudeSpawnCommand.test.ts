/**
 * B-1..B-6 — per-agent Claude model + effort override.
 *
 * These assert the COMPOSED COMMAND STRING that is written into the pane's
 * shell, which is the live spawn path. `providerConfigs.ptyCommand` is dead
 * code (zero references in src/), so an argv assertion written against it
 * would pass while the child received nothing — the exact failure mode B-2
 * exists to catch.
 */

import { describe, it, expect } from 'vitest';
import { buildClaudeSpawnCommand, resolveClaudeEffort } from './claudeSpawnCommand';
import { CLAUDE_EFFORTS, CLAUDE_EFFORT_LABELS, type ClaudeEffort } from '../shared/types';

describe('B-3 — effort levels are a single source of truth', () => {
  it('includes xhigh, which claude 2.1.220 accepts', () => {
    // Was missing from all five hand-written copies of this union, so a level
    // Claude supports could never be selected.
    expect(CLAUDE_EFFORTS).toContain('xhigh');
    expect([...CLAUDE_EFFORTS]).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
  });

  it('labels every level, so a new one cannot render blank', () => {
    for (const level of CLAUDE_EFFORTS) {
      expect(CLAUDE_EFFORT_LABELS[level]).toBeTruthy();
    }
    expect(Object.keys(CLAUDE_EFFORT_LABELS)).toHaveLength(CLAUDE_EFFORTS.length);
  });

  it('reaches the child for every level including xhigh', () => {
    for (const level of CLAUDE_EFFORTS) {
      expect(buildClaudeSpawnCommand({ effort: level })).toContain(`--effort ${level}`);
    }
  });
});

describe('B-4 — effort precedence chain', () => {
  // override → settings.claudeEffort → 'high'. Tested explicitly, not assumed.
  it('prefers the per-placement override', () => {
    expect(resolveClaudeEffort('low', 'max')).toBe('low');
  });

  it('falls back to the global setting when there is no override', () => {
    expect(resolveClaudeEffort(undefined, 'max')).toBe('max');
  });

  it("falls back to 'high' when neither is set", () => {
    expect(resolveClaudeEffort(undefined, undefined)).toBe('high');
  });

  it('does not let an empty-string override win', () => {
    expect(resolveClaudeEffort('' as ClaudeEffort, 'medium')).toBe('medium');
  });
});

describe('B-2 — the model actually reaches the child', () => {
  it('puts --model in the composed command', () => {
    const cmd = buildClaudeSpawnCommand({ effort: 'high', modelOverride: 'opus' });
    expect(cmd).toContain('--model opus');
  });

  it('accepts a full model name as well as an alias', () => {
    const cmd = buildClaudeSpawnCommand({ effort: 'high', modelOverride: 'claude-sonnet-4-6' });
    expect(cmd).toContain('--model claude-sonnet-4-6');
  });

  it('omits --model entirely when no override is set', () => {
    // Absent must mean absent: an empty `--model` would fail the spawn.
    const cmd = buildClaudeSpawnCommand({ effort: 'high' });
    expect(cmd).not.toContain('--model');
  });

  it('treats null and empty string as unset', () => {
    expect(buildClaudeSpawnCommand({ effort: 'high', modelOverride: null })).not.toContain('--model');
    expect(buildClaudeSpawnCommand({ effort: 'high', modelOverride: '' })).not.toContain('--model');
  });
});

describe('composed command shape', () => {
  it('uses --system-prompt-file, never bare --system-prompt', () => {
    // --system-prompt takes literal TEXT; passing a path made the path string
    // the entire system prompt (QAPert, 2026-07-29).
    const cmd = buildClaudeSpawnCommand({
      effort: 'high',
      bootPromptTmpPath: 'C:/tmp/boot-prompt-NextPert.txt',
    });
    expect(cmd).toContain('--system-prompt-file "C:/tmp/boot-prompt-NextPert.txt"');
    expect(cmd).not.toMatch(/--system-prompt(?!-file)/);
  });

  it('quotes the boot prompt path so spaces survive', () => {
    const cmd = buildClaudeSpawnCommand({
      effort: 'high',
      bootPromptTmpPath: 'C:/Users/jon local/AppData/boot.txt',
    });
    expect(cmd).toContain('"C:/Users/jon local/AppData/boot.txt"');
  });

  it('omits the flag when there is no boot prompt', () => {
    expect(buildClaudeSpawnCommand({ effort: 'high' })).not.toContain('--system-prompt-file');
  });

  it('keeps the kickoff and skip-permissions flag, and ends with CR', () => {
    const cmd = buildClaudeSpawnCommand({ effort: 'high' });
    expect(cmd.startsWith('claude "Begin."')).toBe(true);
    expect(cmd).toContain('--dangerously-skip-permissions');
    expect(cmd.endsWith('\r')).toBe(true);
  });

  it('composes model + effort + boot prompt together', () => {
    const cmd = buildClaudeSpawnCommand({
      effort: 'xhigh',
      modelOverride: 'opus',
      bootPromptTmpPath: 'C:/tmp/b.txt',
    });
    expect(cmd).toBe(
      'claude "Begin." --dangerously-skip-permissions --effort xhigh --model opus --system-prompt-file "C:/tmp/b.txt"\r',
    );
  });
});

describe('session continuity flags', () => {
  it('omits session flags entirely when no id is given (unchanged legacy spawn)', () => {
    const cmd = buildClaudeSpawnCommand({ effort: 'high' });
    expect(cmd).not.toContain('--session-id');
    expect(cmd).not.toContain('--resume');
  });

  it('CREATES with --session-id when no transcript exists', () => {
    const cmd = buildClaudeSpawnCommand({ effort: 'high', sessionId: 'u-1', resume: false });
    expect(cmd).toContain('--session-id u-1');
    expect(cmd).not.toContain('--resume');
  });

  it('RESUMES with --resume when a transcript exists', () => {
    const cmd = buildClaudeSpawnCommand({ effort: 'high', sessionId: 'u-1', resume: true });
    expect(cmd).toContain('--resume u-1');
    expect(cmd).not.toContain('--session-id');
  });

  it('never emits both — --session-id on an in-use id errors and kills the spawn', () => {
    const cmd = buildClaudeSpawnCommand({ effort: 'high', sessionId: 'u-1', resume: true });
    const both = cmd.includes('--session-id') && cmd.includes('--resume');
    expect(both).toBe(false);
  });

  it('re-passes --system-prompt-file ON RESUME — without it the agent keeps the conversation but loses its operating rules', () => {
    const cmd = buildClaudeSpawnCommand({
      effort: 'high',
      sessionId: 'u-1',
      resume: true,
      bootPromptTmpPath: 'C:\tmp\bp.txt',
    });
    expect(cmd).toContain('--resume u-1');
    expect(cmd).toContain('--system-prompt-file "C:\tmp\bp.txt"');
  });

  it('composes model + effort + resume together', () => {
    const cmd = buildClaudeSpawnCommand({
      effort: 'xhigh',
      modelOverride: 'haiku',
      sessionId: 'u-9',
      resume: true,
    });
    expect(cmd).toContain('--effort xhigh');
    expect(cmd).toContain('--model haiku');
    expect(cmd).toContain('--resume u-9');
  });
});
