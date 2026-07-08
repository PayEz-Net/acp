import { describe, it, expect } from 'vitest';
import { stripAnsi } from './ansi';

describe('stripAnsi', () => {
  it('removes SGR color/style codes', () => {
    expect(stripAnsi('\u001b[31mred\u001b[0m')).toBe('red');
    expect(stripAnsi('\u001b[1;32mBold Green\u001b[0m')).toBe('Bold Green');
    expect(stripAnsi('\u001b[90mdim\u001b[39m')).toBe('dim');
  });

  it('removes 256-color codes', () => {
    expect(stripAnsi('\u001b[38;5;196m256 red\u001b[0m')).toBe('256 red');
    expect(stripAnsi('\u001b[48;5;16mbg\u001b[0m')).toBe('bg');
  });

  it('removes truecolor (24-bit) codes', () => {
    expect(stripAnsi('\u001b[38;2;255;0;0mtrue red\u001b[0m')).toBe('true red');
    expect(stripAnsi('\u001b[48;2;0;128;255mbg\u001b[0m')).toBe('bg');
  });

  it('removes cursor show/hide sequences', () => {
    expect(stripAnsi('\u001b[?25lhidden\u001b[?25h')).toBe('hidden');
  });

  it('removes erase-line sequences', () => {
    expect(stripAnsi('\u001b[2Kerased\u001b[K')).toBe('erased');
  });

  it('removes OSC hyperlinks and titles', () => {
    expect(stripAnsi('\u001b]8;;https://example.com\u0007link\u001b]8;;\u0007')).toBe('link');
    expect(stripAnsi('\u001b]0;window title\u0007text')).toBe('text');
    expect(stripAnsi('\u001b]8;;https://x.com\u001b\\link\u001b]8;;\u001b\\')).toBe('link');
  });

  it('handles combined sequences', () => {
    const raw = '\u001b[?25l\u001b[32m\u001b[2K\u001b[1mOK\u001b[0m\u001b[?25h';
    expect(stripAnsi(raw)).toBe('OK');
  });

  it('removes cursor movement sequences', () => {
    expect(stripAnsi('\u001b[656DActually')).toBe('Actually');
    expect(stripAnsi('\u001b[92mtext\u001b[0m')).toBe('text');
  });

  it('removes CSI sequences introduced by the single-byte CSI (C1) character', () => {
    expect(stripAnsi('\x9b31mred\x9b0m')).toBe('red');
  });

  it('strips incomplete CSI sequences split across the bridge', () => {
    expect(stripAnsi('\u001b[656')).toBe('');
    expect(stripAnsi('\u001b[656;92')).toBe('');
    expect(stripAnsi('\u001b[?25')).toBe('');
    expect(stripAnsi('text\u001b[656')).toBe('text');
  });

  it('strips a trailing lone ESC from a split sequence', () => {
    expect(stripAnsi('text\u001b')).toBe('text');
    expect(stripAnsi('\u001b')).toBe('');
  });

  it('leaves plain text unchanged', () => {
    expect(stripAnsi('plain text')).toBe('plain text');
    expect(stripAnsi('[656] and [foo] are not escapes')).toBe('[656] and [foo] are not escapes');
    expect(stripAnsi('issue #2: fix the bug')).toBe('issue #2: fix the bug');
  });

  it('strips orphaned SGR/cursor fragments when ESC is missing', () => {
    // These leak when a sequence is split across the PTY bridge and the ESC
    // byte has already been consumed by an earlier chunk.
    expect(stripAnsi('[3 Reasoning...')).toBe('Reasoning...');
    expect(stripAnsi('[37mcolored text')).toBe('colored text');
    expect(stripAnsi('[38;5;123mcolored text')).toBe('colored text');
    expect(stripAnsi('[2;12Hcursor text')).toBe('cursor text');
  });

  it('strips trailing cursor-position fragments', () => {
    expect(stripAnsi('text\r2;12H')).toBe('text\r');
    expect(stripAnsi('text1;1f')).toBe('text');
  });
});
