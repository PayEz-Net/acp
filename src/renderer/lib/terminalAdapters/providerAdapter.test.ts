import { describe, it, expect } from 'vitest';
import { normalizeTerminalLine, getTerminalAdapter } from '../terminalProviderAdapters';

import claudeFixture from './__fixtures__/claude-session.json';
import kimiFixture from './__fixtures__/kimi-session.json';
import codexFixture from './__fixtures__/codex-session.json';

describe('provider adapters (plain-text inputs)', () => {
  it.each([
    { provider: 'claude' as const, fixture: claudeFixture },
    { provider: 'kimi' as const, fixture: kimiFixture },
    { provider: 'codex' as const, fixture: codexFixture },
  ])('normalizes every fixture case for $provider', ({ provider, fixture }) => {
    for (const c of fixture.cases) {
      const normalized = normalizeTerminalLine(provider, c.input);
      expect(normalized).toBe(c.expected);
    }
  });

  it('strips spinner glyphs', () => {
    expect(normalizeTerminalLine('claude', '⠋ Reading files...')).toBe('Reading files...');
    expect(normalizeTerminalLine('kimi', '◐ Working...')).toBe('Working...');
    expect(normalizeTerminalLine('codex', '⠏ Executing...')).toBe('Executing...');
  });

  it('replaces Kimi image placeholders with ⟨image⟩', () => {
    expect(normalizeTerminalLine('kimi', '[IMAGE: screenshot.png]')).toBe('⟨image⟩');
    expect(normalizeTerminalLine('kimi', 'Before [IMAGE: a.png] after')).toBe('Before ⟨image⟩ after');
  });

  it('normalizes Codex model labels to Codex', () => {
    expect(normalizeTerminalLine('codex', 'codex-mini')).toBe('Codex');
    expect(normalizeTerminalLine('codex', 'codex-mini-latest')).toBe('Codex');
    expect(normalizeTerminalLine('codex', 'Running codex-mini-latest now')).toBe('Running Codex now');
  });

  it('returns a fallback adapter for unknown providers', () => {
    const adapter = getTerminalAdapter('unknown');
    expect(adapter.normalizeLine('hi')).toBe('hi');
  });
});
