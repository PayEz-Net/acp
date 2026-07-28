/**
 * Per-terminal screen model.
 *
 * ConPTY does not relay the app's raw byte stream — it re-emits *screen-state
 * updates* (cursor moves, line clears, full-frame repaints). The agent-output
 * pipeline strips that cursor addressing and flattens the stream into
 * append-only lines, so every in-place repaint (spinner ticks, and especially
 * pi-tui's resize repaint, which re-renders its entire component tree behind
 * ESC[2J ESC[H ESC[3J) lands as duplicated/fragmented lines in the pane.
 * That is the root cause of the recurring "terminal content doesn't resize"
 * class of bugs.
 *
 * This model sits on the raw node-pty stream and maintains a minimal logical
 * screen: a list of unwrapped rows plus a cursor. It applies the ConPTY /
 * pi-tui escape dialect (CUP/CUU/CUD/CUF/CUB, CR/LF, EL, ED, IL/DL/ICH/DCH,
 * save/restore, scroll) and emits frame updates:
 *   - `screen`: the current visible rows (replace semantics),
 *   - `historyAppended`: rows that scrolled off the top since the last update
 *     (append semantics — these flow through the renderer's normalizer),
 *   - `historyCleared`: the app erased scrollback (ED 3), so the renderer
 *     should drop its stored history before applying new appends.
 *
 * Rows are kept as logical lines (NOT hard-wrapped at `cols`): the renderer
 * wraps visually with CSS, so pane resizes reflow text for free and content
 * drawn at exactly `cols` never loses its final character. Cursor fidelity
 * within a row is cell-based and treats every code point as one cell; pi-tui
 * pads/rewrites whole lines, so overwrite fidelity is adequate in practice.
 *
 * The class is pure (no timers): callers `feed()` raw chunks and periodically
 * `takeUpdate()` to drain the coalesced frame update.
 */

export interface TerminalFrameUpdate {
  terminalId: string;
  agentName: string;
  /** Current visible screen rows (trailing blank rows trimmed). */
  screen: string[];
  /** Rows that scrolled into history since the previous update. */
  historyAppended: string[];
  /** ED 3 was seen: renderer must drop stored history for this terminal. */
  historyCleared: boolean;
}

const ESC = '\x1b';
const BEL = '\x07';

export class TerminalScreen {
  private lines: string[] = [''];
  private row = 0;
  private col = 0;
  private savedRow = 0;
  private savedCol = 0;
  private cols: number;
  private rows: number;
  private appended: string[] = [];
  private cleared = false;
  private dirty = false;
  /** Incomplete escape-sequence tail carried across feed() chunk boundaries. */
  private pending = '';

  constructor(
    private readonly terminalId: string,
    private readonly agentName: string,
    cols: number,
    rows: number,
  ) {
    this.cols = Math.max(1, cols);
    this.rows = Math.max(1, rows);
  }

  feed(data: string): void {
    if (!data) return;
    const s = this.pending + data;
    this.pending = '';
    const n = s.length;
    let i = 0;
    let textStart = 0;
    const flushText = (end: number) => {
      if (end > textStart) this.writeText(s.slice(textStart, end));
    };

    while (i < n) {
      const ch = s[i];
      if (ch === ESC) {
        if (i + 1 >= n) {
          this.pending = s.slice(i);
          return;
        }
        flushText(i);
        const next = s[i + 1];
        if (next === '[') {
          // CSI: parameter bytes until a final byte in 0x40–0x7E.
          let j = i + 2;
          while (j < n) {
            const code = s.charCodeAt(j);
            if (code >= 0x40 && code <= 0x7e) break;
            j++;
          }
          if (j >= n) {
            this.pending = s.slice(i);
            return;
          }
          this.csi(s.slice(i + 2, j), s[j]);
          i = j + 1;
        } else if (next === ']') {
          // OSC: consume until BEL or ESC\.
          const end = this.scanStringSequence(s, i + 2);
          if (end === -1) {
            this.pending = s.slice(i);
            return;
          }
          i = end;
        } else if (next === 'P' || next === '_' || next === '^') {
          // DCS / APC / PM: consume until ESC\.
          const end = this.scanEscTerminated(s, i + 2);
          if (end === -1) {
            this.pending = s.slice(i);
            return;
          }
          i = end;
        } else if (next === '(' || next === ')' || next === '*' || next === '+' || next === '#') {
          // Charset / DEC alignment: two-byte body.
          if (i + 2 >= n) {
            this.pending = s.slice(i);
            return;
          }
          i += 3;
        } else {
          this.twoChar(next);
          i += 2;
        }
        textStart = i;
        continue;
      }
      if (ch === '\r' || ch === '\n' || ch === '\t' || ch === '\x08' || ch === '\x0b' || ch === '\x0c') {
        flushText(i);
        this.control(ch);
        i++;
        textStart = i;
        continue;
      }
      if (ch === BEL || ch === '\x00') {
        flushText(i);
        i++;
        textStart = i;
        continue;
      }
      i++;
    }
    flushText(n);
  }

  resize(cols: number, rows: number): void {
    this.cols = Math.max(1, cols);
    this.rows = Math.max(1, rows);
    // Shrink: rows that no longer fit scroll into history (append semantics —
    // the renderer already displays them above the screen, so nothing moves
    // visually). Grow: leave rows in renderer history rather than pulling
    // them back, which would duplicate them when they scroll off again.
    while (this.lines.length > this.rows) {
      this.appended.push(this.lines.shift()!);
    }
    if (this.row >= this.rows) this.row = this.rows - 1;
    this.dirty = true;
  }

  /** Drain the coalesced frame update, or null when nothing changed. */
  takeUpdate(): TerminalFrameUpdate | null {
    if (!this.dirty && this.appended.length === 0 && !this.cleared) return null;
    let end = this.lines.length;
    while (end > 1 && this.lines[end - 1].trim() === '') end--;
    const screen = this.lines.slice(0, end).map((l) => l.replace(/\s+$/, ''));
    const update: TerminalFrameUpdate = {
      terminalId: this.terminalId,
      agentName: this.agentName,
      screen,
      historyAppended: this.appended.splice(0),
      historyCleared: this.cleared,
    };
    this.cleared = false;
    this.dirty = false;
    return update;
  }

  // --- internals -----------------------------------------------------------

  private scanStringSequence(s: string, start: number): number {
    for (let j = start; j < s.length; j++) {
      if (s.charCodeAt(j) === 7) return j + 1;
      if (s[j] === ESC && j + 1 < s.length && s[j + 1] === '\\') return j + 2;
    }
    return -1;
  }

  private scanEscTerminated(s: string, start: number): number {
    for (let j = start; j < s.length; j++) {
      if (s[j] === ESC && j + 1 < s.length && s[j + 1] === '\\') return j + 2;
    }
    return -1;
  }

  private control(ch: string): void {
    if (ch === '\r') {
      this.col = 0;
    } else if (ch === '\n' || ch === '\x0b' || ch === '\x0c') {
      this.linefeed();
    } else if (ch === '\t') {
      this.col = Math.min(this.cols - 1, (this.col + 8) & ~7);
    } else if (ch === '\x08') {
      this.col = Math.max(0, this.col - 1);
    }
  }

  private linefeed(): void {
    this.row++;
    if (this.row >= this.rows) {
      this.scrollUp(1);
      this.row = this.rows - 1;
    }
    while (this.lines.length <= this.row) this.lines.push('');
  }

  private scrollUp(n: number): void {
    for (let k = 0; k < n; k++) {
      if (this.lines.length >= this.rows) {
        this.appended.push(this.lines.shift()!);
      }
      this.lines.push('');
    }
    while (this.lines.length > this.rows) this.lines.pop();
    this.dirty = true;
  }

  private writeText(text: string): void {
    for (const cp of text) {
      const code = cp.codePointAt(0)!;
      // Drop stray C0/C1 controls and DEL that were not handled upstream.
      if (code < 0x20 || code === 0x7f || (code >= 0x80 && code < 0xa0)) continue;
      if (this.col >= this.cols) this.linefeed(); // deferred wrap
      this.put(cp);
      this.col++;
    }
  }

  private put(cp: string): void {
    const chars = Array.from(this.lines[this.row] ?? '');
    while (chars.length < this.col) chars.push(' ');
    chars[this.col] = cp;
    this.lines[this.row] = chars.join('');
    this.dirty = true;
  }

  private eraseLine(mode: number): void {
    if (mode === 2) {
      this.lines[this.row] = '';
    } else if (mode === 0) {
      const chars = Array.from(this.lines[this.row] ?? '');
      chars.length = Math.min(chars.length, this.col);
      this.lines[this.row] = chars.join('');
    } else if (mode === 1) {
      const chars = Array.from(this.lines[this.row] ?? '');
      for (let k = 0; k <= this.col && k < chars.length; k++) chars[k] = ' ';
      this.lines[this.row] = chars.join('');
    }
    this.dirty = true;
  }

  private eraseDisplay(mode: number): void {
    if (mode === 2) {
      for (let r = 0; r < this.lines.length; r++) this.lines[r] = '';
    } else if (mode === 0) {
      this.eraseLine(0);
      for (let r = this.row + 1; r < this.lines.length; r++) this.lines[r] = '';
    } else if (mode === 1) {
      for (let r = 0; r < this.row; r++) this.lines[r] = '';
      this.eraseLine(1);
    } else if (mode === 3) {
      // Scrollback clear: pi-tui's resize repaint prelude (ESC[2J ESC[H ESC[3J).
      this.cleared = true;
    }
    this.dirty = true;
  }

  private twoChar(c: string): void {
    if (c === '7') {
      this.savedRow = this.row;
      this.savedCol = this.col;
    } else if (c === '8') {
      this.row = Math.min(this.savedRow, this.rows - 1);
      this.col = Math.min(this.savedCol, this.cols - 1);
      while (this.lines.length <= this.row) this.lines.push('');
    } else if (c === 'M') {
      // Reverse index: scroll down at top margin.
      if (this.row === 0) {
        this.lines.unshift('');
        if (this.lines.length > this.rows) this.lines.pop();
        this.dirty = true;
      } else {
        this.row--;
      }
    } else if (c === 'D') {
      this.linefeed();
    } else if (c === 'E') {
      this.linefeed();
      this.col = 0;
    } else if (c === 'c') {
      // Full reset.
      this.lines = [''];
      this.row = 0;
      this.col = 0;
      this.cleared = true;
      this.dirty = true;
    }
    // '=' / '>' (keypad modes) and anything else: ignore.
  }

  private csi(params: string, final: string): void {
    // Strip a leading private marker ('?', '>', '!') — the affected functions
    // (h/l/m) are ignored either way.
    const p = params.replace(/^[?>!]/, '');
    const nums = p === '' ? [] : p.split(';').map((x) => parseInt(x, 10));
    const num = (idx: number, dflt: number): number => {
      const v = nums[idx];
      return v === undefined || Number.isNaN(v) || v === 0 ? dflt : v;
    };
    const clampRow = (r: number) => Math.max(0, Math.min(this.rows - 1, r));
    const clampCol = (c: number) => Math.max(0, Math.min(this.cols - 1, c));

    switch (final) {
      case 'H':
      case 'f': {
        this.row = clampRow(num(0, 1) - 1);
        this.col = clampCol(num(1, 1) - 1);
        while (this.lines.length <= this.row) this.lines.push('');
        break;
      }
      case 'A': this.row = clampRow(this.row - num(0, 1)); break;
      case 'B': this.row = clampRow(this.row + num(0, 1)); break;
      case 'C': this.col = clampCol(this.col + num(0, 1)); break;
      case 'D': this.col = clampCol(this.col - num(0, 1)); break;
      case 'E': this.row = clampRow(this.row + num(0, 1)); this.col = 0; break;
      case 'F': this.row = clampRow(this.row - num(0, 1)); this.col = 0; break;
      case 'G':
      case '`': this.col = clampCol(num(0, 1) - 1); break;
      case 'd': this.row = clampRow(num(0, 1) - 1); break;
      case 'J': this.eraseDisplay(num(0, 0)); break;
      case 'K': this.eraseLine(num(0, 0)); break;
      case 'X': {
        const chars = Array.from(this.lines[this.row] ?? '');
        for (let k = this.col; k < this.col + num(0, 1) && k < chars.length; k++) chars[k] = ' ';
        this.lines[this.row] = chars.join('');
        this.dirty = true;
        break;
      }
      case 'S': this.scrollUp(num(0, 1)); break;
      case 'T': {
        const count = num(0, 1);
        for (let k = 0; k < count; k++) {
          this.lines.unshift('');
          if (this.lines.length > this.rows) this.lines.pop();
        }
        this.dirty = true;
        break;
      }
      case 'L': {
        const count = num(0, 1);
        const blanks = Array.from({ length: count }, () => '');
        this.lines.splice(this.row, 0, ...blanks);
        this.lines.length = Math.min(this.lines.length, this.rows);
        this.dirty = true;
        break;
      }
      case 'M': {
        const count = num(0, 1);
        this.lines.splice(this.row, count);
        while (this.lines.length < this.rows) this.lines.push('');
        this.dirty = true;
        break;
      }
      case '@': {
        const chars = Array.from(this.lines[this.row] ?? '');
        chars.splice(this.col, 0, ...Array.from({ length: num(0, 1) }, () => ' '));
        this.lines[this.row] = chars.join('');
        this.dirty = true;
        break;
      }
      case 'P': {
        const chars = Array.from(this.lines[this.row] ?? '');
        chars.splice(this.col, num(0, 1));
        this.lines[this.row] = chars.join('');
        this.dirty = true;
        break;
      }
      case 's':
        this.savedRow = this.row;
        this.savedCol = this.col;
        break;
      case 'u':
        this.row = clampRow(this.savedRow);
        this.col = clampCol(this.savedCol);
        while (this.lines.length <= this.row) this.lines.push('');
        break;
      default:
        // SGR (m), modes (h/l), DECSTBM (r), DSR/DA (n/c), etc.: no visual
        // effect on the logical screen — ignore.
        break;
    }
  }
}
