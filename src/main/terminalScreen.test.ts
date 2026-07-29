import { describe, it, expect } from 'vitest';
import { TerminalScreen } from './terminalScreen';

function make(cols = 24, rows = 5): TerminalScreen {
  return new TerminalScreen('term-1', 'NextPert', cols, rows);
}

describe('TerminalScreen', () => {
  it('renders plain lines separated by CRLF', () => {
    const s = make();
    s.feed('hello\r\nworld\r\n');
    const u = s.takeUpdate()!;
    expect(u.screen).toEqual(['hello', 'world']);
    expect(u.historyAppended).toEqual([]);
    expect(u.historyCleared).toBe(false);
  });

  it('returns null when nothing changed', () => {
    const s = make();
    expect(s.takeUpdate()).toBeNull();
  });

  it('scrolls overflow rows into historyAppended', () => {
    const s = make(24, 3);
    s.feed('one\r\ntwo\r\nthree\r\nfour\r\nfive\r\n');
    const u = s.takeUpdate()!;
    expect(u.historyAppended).toEqual(['one', 'two', 'three']);
    expect(u.screen).toEqual(['four', 'five']);
  });

  it('overwrites in place after carriage return (progress redraw)', () => {
    const s = make();
    s.feed('partial text\rfull\r\n');
    expect(s.takeUpdate()!.screen).toEqual(['fullial text']);
  });

  it('applies erase-line rewrites without appending (spinner tick)', () => {
    const s = make();
    s.feed('line one\r\n⠋ spin');
    s.takeUpdate();
    s.feed('\r\x1b[2K⠙ spin');
    const u = s.takeUpdate()!;
    expect(u.screen).toEqual(['line one', '⠙ spin']);
    expect(u.historyAppended).toEqual([]);
  });

  it('applies cursor-up rewrites to earlier rows', () => {
    const s = make();
    s.feed('A\r\nB\r\n');
    s.takeUpdate();
    s.feed('\x1b[1A\r\x1b[2KC');
    expect(s.takeUpdate()!.screen).toEqual(['A', 'C']);
  });

  it('ED 3 repaint marks historyCleared and replaces the frame', () => {
    const s = make();
    s.feed('old one\r\nold two\r\n');
    s.takeUpdate();
    s.feed('\x1b[2J\x1b[H\x1b[3Jnew one\r\nnew two\r\n');
    const u = s.takeUpdate()!;
    expect(u.historyCleared).toBe(true);
    expect(u.screen).toEqual(['new one', 'new two']);
    // Next update must not repeat the cleared flag.
    expect(s.takeUpdate()).toBeNull();
  });

  it('resize shrink scrolls overflow rows into history', () => {
    const s = make(24, 5);
    s.feed('1\r\n2\r\n3\r\n4\r\n5');
    s.takeUpdate();
    s.resize(24, 3);
    const u = s.takeUpdate()!;
    expect(u.historyAppended).toEqual(['1', '2']);
    expect(u.screen).toEqual(['3', '4', '5']);
  });

  it('resize grow keeps history in the renderer (no pull-back duplication)', () => {
    const s = make(24, 3);
    s.feed('one\r\ntwo\r\nthree\r\n');
    s.takeUpdate();
    s.resize(24, 6);
    const u = s.takeUpdate()!;
    expect(u.historyAppended).toEqual([]);
    expect(u.screen).toEqual(['two', 'three']);
  });

  it('handles escape sequences split across chunks', () => {
    const s = make();
    s.feed('abc\x1b[');
    s.feed('2K');
    const u = s.takeUpdate()!;
    expect(u.screen).toEqual(['']);
  });

  it('strips SGR and OSC sequences', () => {
    const s = make();
    s.feed('\x1b]0;window title\x07\x1b[1;31mred text\x1b[0m\r\n');
    expect(s.takeUpdate()!.screen).toEqual(['red text']);
  });

  it('keeps exact-width lines intact (no lost final column)', () => {
    const s = make(5, 5);
    s.feed('abcde\r\n');
    expect(s.takeUpdate()!.screen).toEqual(['abcde']);
  });

  it('wraps over-width writes with deferred wrap like a real terminal', () => {
    const s = make(5, 5);
    s.feed('abcdef\r\n');
    expect(s.takeUpdate()!.screen).toEqual(['abcde', 'f']);
  });

  it('pads writes after absolute cursor positioning', () => {
    const s = make();
    s.feed('\x1b[1;5HX\r\n');
    expect(s.takeUpdate()!.screen).toEqual(['    X']);
  });

  // --- POST-flood fix: only settled rows reach the stored output record ------
  // pty.ts reports `historyAppended`, never raw chunks. These pin the property
  // that makes that safe. Previously every repaint below was one POST.

  it('in-place repaints produce NO history rows', () => {
    const s = make(40, 10);
    // 20 spinner frames rewriting the same row, as a TUI repaints one.
    for (let i = 0; i < 20; i++) s.feed(`\rRuminating… (${i}s)`);
    const u = s.takeUpdate()!;
    expect(u.historyAppended).toEqual([]);
    expect(u.screen.length).toBe(1);
  });

  it('rows that scroll off ARE reported as history', () => {
    // Control arm: zero history above means nothing only if scrolling
    // provably yields history on the same instrument.
    const s = make(40, 3);
    s.feed('one\r\ntwo\r\nthree\r\nfour\r\n');
    expect(s.takeUpdate()!.historyAppended.length).toBeGreaterThan(0);
  });

  it('snapshot reads visible rows without draining state', () => {
    const s = make(20, 5);
    s.feed('hello\r\n');
    s.takeUpdate();
    expect(s.snapshot()).toEqual(['hello']);
    // A pure read: it must not mark the screen dirty, or teardown would
    // re-report rows that were already sent.
    expect(s.takeUpdate()).toBeNull();
  });
});
