import { describe, it, expect } from 'vitest';
import { buildImageInputCommand } from './terminalInputAdapters';

describe('buildImageInputCommand', () => {
  it('writes each quoted path on its own line followed by text and a carriage return', () => {
    const out = buildImageInputCommand('claude', ['/tmp/a.png', '/tmp/b.png'], 'what is this?');
    expect(out).toBe('"/tmp/a.png"\n"/tmp/b.png"\nwhat is this?\r');
  });

  it('works for kimi and codex providers with the same contract', () => {
    const paths = ['/tmp/kimi.png'];
    expect(buildImageInputCommand('kimi', paths, 'explain')).toBe('"/tmp/kimi.png"\nexplain\r');
    expect(buildImageInputCommand('codex', paths, 'explain')).toBe('"/tmp/kimi.png"\nexplain\r');
  });

  it('escapes embedded double quotes in paths', () => {
    const out = buildImageInputCommand('claude', ['/tmp/"weird".png'], 'ok');
    expect(out).toBe('"/tmp/\\"weird\\".png"\nok\r');
  });

  it('returns only the text with a carriage return when there are no images', () => {
    const out = buildImageInputCommand('claude', [], 'plain text');
    expect(out).toBe('plain text\r');
  });

  it('returns only quoted paths with a carriage return when text is empty', () => {
    const out = buildImageInputCommand('claude', ['/tmp/a.png'], '');
    expect(out).toBe('"/tmp/a.png"\r');
  });

  it('trims whitespace from the text body', () => {
    const out = buildImageInputCommand('claude', ['/tmp/a.png'], '  surrounded by spaces  ');
    expect(out).toBe('"/tmp/a.png"\nsurrounded by spaces\r');
  });

  it('returns an empty string when both images and text are empty', () => {
    expect(buildImageInputCommand('claude', [], '')).toBe('');
  });
});
