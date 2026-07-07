/**
 * Minimal ANSI escape-sequence stripping.
 *
 * Scope: the sequences actually emitted by Claude, Kimi, and Codex (SGR
 * colors/styles, 24-bit and 256-color codes, cursor show/hide, erase-line,
 * generic CSI sequences, OSC hyperlinks/titles). This is intentionally not a
 * full VT100 parser.
 */

const ANSI_ERASE_LINE = /\u001b\[\d?K/g;
const ANSI_CURSOR_SHOW_HIDE = /\u001b\[\?25[hl]/g;
const ANSI_COLOR_AND_STYLE = /\u001b\[(?:\d+;)*\d*m/g;
const ANSI_GENERIC_CSI = /\u001b\[[\d;?]*[A-Za-z]/g;
const ANSI_OSC = /\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g;

/** Remove ANSI escape sequences from a string. */
export function stripAnsi(input: string): string {
  return input
    .replace(ANSI_OSC, '')
    .replace(ANSI_ERASE_LINE, '')
    .replace(ANSI_CURSOR_SHOW_HIDE, '')
    .replace(ANSI_COLOR_AND_STYLE, '')
    .replace(ANSI_GENERIC_CSI, '');
}
