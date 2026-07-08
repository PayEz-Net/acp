/**
 * Minimal ANSI escape-sequence stripping.
 *
 * Scope: the sequences actually emitted by Claude, Kimi, and Codex (SGR
 * colors/styles, 24-bit and 256-color codes, cursor show/hide, erase-line,
 * generic CSI sequences, OSC hyperlinks/titles). This is intentionally not a
 * full VT100 parser.
 *
 * Bridge note: node-pty chunks can split an escape sequence across data events.
 * We strip complete sequences *and* trailing incomplete sequences so fragments
 * like "ESC[656" or a lone ESC at a chunk boundary do not leak into the DOM
 * line renderer.
 */

const ANSI_ERASE_LINE = /\u001b\[\d?K/g;
const ANSI_CURSOR_SHOW_HIDE = /\u001b\[\?25[hl]/g;
const ANSI_COLOR_AND_STYLE = /\u001b\[(?:\d+;)*\d*m/g;
// Standard CSI final bytes include @ A-Z [ \ ] ^ _ ` a-z { | } ~ .
// Also allow private-marker prefixes < = ? for completeness.
const ANSI_GENERIC_CSI = /(?:\u001b\[|\x9b)[<=?]?[\d;]*[@A-Za-z\\[\]^_`{|}~]/g;
const ANSI_OSC = /\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g;
// Incomplete CSI at end of string (sequence was split across the bridge).
const ANSI_CSI_INCOMPLETE = /(?:\u001b\[|\x9b)[<=?]?[\d;]*$/g;
// A lone ESC at the very end is almost certainly a split sequence.
const ANSI_LONE_ESC = /\u001b$/g;

// Orphaned SGR/cursor fragments that can leak into the pane when a sequence is
// split across PTY chunks or SSE events and the ESC byte is already stripped.
// These look like "[3 ", "[37m", "[38;5;123m", "[2;12H" and usually appear at
// a line boundary. We strip them defensively after the real ANSI pass, but we
// keep the patterns narrow (only real SGR/cursor params and final bytes) so we
// do not remove legitimate bracketed text like "[656]" or "[foo]".
//
// SGR parameters are restricted to 0-99 plus 256/truecolor forms, and a
// negative lookahead prevents matching the first two digits of a longer number.
const SGR_PARAMS = '(?:[0-9]{1,2}(?![0-9])(?:;[0-9]{1,2}(?![0-9]))*|38;5;\\d{1,3}(?![0-9])|38;2;\\d{1,3}(?:;\\d{1,3}){2}|48;5;\\d{1,3}(?![0-9])|48;2;\\d{1,3}(?:;\\d{1,3}){2})';
const ORPHANED_SGR_START = new RegExp(`^[\\s]*\\[${SGR_PARAMS}(?:m\\s*|\\s+)`, 'gm');
const ORPHANED_SGR_WHOLE = new RegExp(`^[\\s]*\\[${SGR_PARAMS}m?[\\s]*$`, 'gm');
// Cursor-position fragments require a real final byte (H/f).
const ORPHANED_CURSOR_START = /^[\s]*\[(?:\d{1,3}(?:;\d{1,3})*)[Hf]\s*/gm;
const ORPHANED_CURSOR_END = /\d{1,3}(?:;\d{1,3})*[Hf]$/g;

/** Remove ANSI escape sequences from a string. */
export function stripAnsi(input: string): string {
  return input
    .replace(ANSI_OSC, '')
    .replace(ANSI_ERASE_LINE, '')
    .replace(ANSI_CURSOR_SHOW_HIDE, '')
    .replace(ANSI_COLOR_AND_STYLE, '')
    .replace(ANSI_GENERIC_CSI, '')
    .replace(ANSI_CSI_INCOMPLETE, '')
    .replace(ANSI_LONE_ESC, '')
    .replace(ORPHANED_SGR_START, '')
    .replace(ORPHANED_CURSOR_START, '')
    .replace(ORPHANED_CURSOR_END, '')
    .replace(ORPHANED_SGR_WHOLE, '');
}
