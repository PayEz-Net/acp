/**
 * Terminal stream normalizer.
 *
 * Stateful post-adapter processing applied to the Agent Output Stream before
 * lines reach `agentOutputStore`. Keeps per-terminal history so
 * `AgentOutputPanel` consumes the collapsed stream.
 *
 * Phase 1 rules:
 *   - Strip ANSI.
 *   - Apply provider adapter (spinner glyph removal, image placeholder,
 *     model-label normalization).
 *   - Collapse consecutive empty/whitespace-only lines to at most two.
 *   - Collapse consecutive frames that normalize to the same text.
 *   - Deduplicate identical lines within a 5-second window.
 *
 * Phase 2 rules:
 *   - Detect thinking sections ("Thinking...", "Analyzing...", "Reasoning..."
 *     labels or <thinking>...</thinking> markers).
 *   - Accumulate thinking content and attach it to the following answer line.
 *   - Emit live thinking placeholders while thinking is in progress so the UI
 *     can show a spinner + preview.
 */

import { stripAnsi } from './ansi';
import { normalizeTerminalLine } from './terminalProviderAdapters';
import { type CodeProvider } from './agentProviders';

export interface StreamLine {
  agent: string;
  terminal_id: string;
  provider?: string;
  line: string;
  ts: string;
  project_id?: string;
  /** Accumulated thinking content associated with this line (the answer). */
  thinking?: string;
  /** When true, this line is a live thinking placeholder that should be replaced by the final answer. */
  thinkingLive?: boolean;
}

interface TerminalHistory {
  lastText: string;
  lastKey: string;
  lastTs: string;
  consecutiveBlankCount: number;
  lastNoiseCategory: NoiseCategory | null;
  // Aggressive footer suppression: TUI status bars redraw across non-status
  // lines, so we suppress any footer-like line within a window of the last one.
  lastFooterTs: string | null;
  // Recent user input sent to this terminal, used to suppress PTY echo.
  echoBuffer: { text: string; ts: string }[];
  // Thinking-block state.
  thinkingBuffer: string[];
  thinkingLabel: string | null;
  thinkingSawBlank: boolean;
  thinkingLiveEmitted: boolean;
}

const DEDUP_WINDOW_MS = 5000;
const ECHO_WINDOW_MS = 5000;
const MAX_THINKING_BUFFER_LINES = 1000;

// Spinner glyphs that may appear anywhere in a provider TUI redraw (not just
// at the line start). Used to build a structural collapse key so frames that
// only differ by spinner position collapse to one line.
// Includes braille/progress glyphs, colored-circle progress indicators, and
// common spinner emojis emitted by Kimi, Claude, and Codex.
const SPINNER_GLYPHS = /[\s]*(?:⠋|⠙|⠹|⠸|⠼|⠴|⠦|⠧|⠇|⠏|⠛|⠶|⠮|⠵|◐|◓|◑|◒|◉|🔴|🟠|🟡|🟢|🔵|🟣|⚫|⚪|🟤|🔘|🟥|🟧|🟨|🟩|🟦|🟪|🟫|🌕|🌑|🌒|🌓|🌔|🌖|🌗|🌘|🌙|🔶|🔷|🔸|🔹|⏳|⌛|🔄|•|●|○|◦|▪|▫|◆|◇|⭐|🌟|✨|💫|⚡|🔥)[\s]*/g;

// Status/noise glyphs that commonly appear on lines by themselves in provider
// TUIs: checkmarks, crosses, dots, progress circles, etc.
const STATUS_GLYPHS = /^(?:[\s]*(?:✓|✔|✗|✘|✕|✖|☐|☑|☒|✅|❌|❎|⚠️|⚠|ℹ️|ℹ|❓|❗|➤|➜|➔|→|⇒|\||\-|⠋|⠙|⠹|⠸|⠼|⠴|⠦|⠧|⠇|⠏|⠛|⠶|⠮|⠵|◐|◓|◑|◒|◉|🔴|🟠|🟡|🟢|🔵|🟣|⚫|⚪|🟤|🔘|🟥|🟧|🟨|🟩|🟦|🟪|🟫|🌕|🌑|🌒|🌓|🌔|🌖|🌗|🌘|🌙|🔶|🔷|🔸|🔹|•|●|○|◦|▪|▫|◆|◇|⭐|🌟|✨|💫|⚡|🔥|\.)+[\s]*)+$/;

// Lines that are purely animated/provider spinner glyphs signal live thinking.
// Distinct from STATUS_GLYPHS so checkmarks, bullets, and separators don't start
// a thinking block.
const THINKING_GLYPHS = /^(?:[\s]*(?:⠋|⠙|⠹|⠸|⠼|⠴|⠦|⠧|⠇|⠏|⠛|⠶|⠮|⠵|◐|◓|◑|◒|◉|🔴|🟠|🟡|🟢|🔵|🟣|⚫|⚪|🟤|🔘|🟥|🟧|🟨|🟩|🟦|🟪|🟫|🌕|🌑|🌒|🌓|🌔|🌖|🌗|🌘|🌙|🔶|🔷|🔸|🔹|⏳|⌛|🔄)[\s]*)+$/;

// Common TUI thinking / working labels. These are emitted repeatedly while the
// model is processing and create scrolling noise in the line-printer renderer.
// Allows optional prompt/box-drawing prefixes (e.g. "│ › Thinking").
const THINKING_LABEL = /^(?:[\s│┃┣├]*[›>➤]\s*(?:thinking|analyzing|analysing|processing|working|reasoning|loading|waiting|running|executing)[\s\.…]*|[\s]*(?:thinking|analyzing|analysing|processing|working|reasoning|loading|waiting|running|executing)[\s\.…]*|[\s]*\.{3,}[\s]*)$/i;

// Repeated separator characters emitted by provider TUIs (e.g. "--- input ---",
// "==========", "~~~~~~~~~~").
const SEPARATOR_LINE = /^(?:[\s]*[-=~_+*#▁▂▃▄▅▆▇█]{3,}[\s]*)+$/;

// Provider footer / status metadata that is redrawn on every TUI frame.
// Catches context-usage lines ("context: 69.4%"), token/cost counters, Kimi
// Code CLI status bars ("yolo agent (K2.7 Code ●) ..."), input prompts, and
// repeating keybinding/help hint lines ("ctrl-x: toggle mode", "@: mention files").
const FOOTER_LINE = /^(?:[\s|]*(?:(?:context|tokens?|usage|cost|cpu|memory|tools?|files?|calls?|provider|model)\s*[:=]\s*[\d\.,\/%\sKMBT$]+(?:\s*(?:tokens?|%))?|yolo agent\b.*|\(\d[\d\.,]*[kmbt]?\/\d[\d\.,]*[kmbt]?\)|[—–]\s*input.*|(?:ctrl|shift|alt|cmd)-[a-z0-9]+:.*|@:\s*mention files|jnewline)\s*[\s|]*)+$/i;

// Explicit XML-style thinking markers (some providers/TUIs emit these).
const THINKING_START_MARKER = /<thinking\b/i;
const THINKING_END_MARKER = /<\/thinking>/i;

// Noise categories for interim TUI noise collapse. Distinct from the structural
// collapse key because we want to suppress *families* of status lines, not just
// exact matches.
type NoiseCategory = 'status-glyph' | 'thinking' | 'separator' | 'footer';

function collapseKey(text: string): string {
  return text
    .replace(SPINNER_GLYPHS, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function classifyNoise(text: string): NoiseCategory | null {
  // Check separator first so that repeated dash/pipe patterns (e.g. '---',
  // '==========') are treated as decorative separators, not status glyphs.
  if (SEPARATOR_LINE.test(text)) return 'separator';
  // Footer/status metadata is redrawn continuously (context %, token counters,
  // cost summaries). Treat as a family so numeric variants collapse.
  if (FOOTER_LINE.test(text)) return 'footer';
  if (STATUS_GLYPHS.test(text)) return 'status-glyph';
  if (THINKING_LABEL.test(text)) return 'thinking';
  return null;
}

function isBlank(text: string): boolean {
  return text.trim().length === 0;
}

// Provider input prompt prefixes that wrap echoed user input (e.g. "— input hello",
// "$ hello"). Stripping these lets us compare the raw user text against what we
// sent to the PTY.
const INPUT_PROMPT_PREFIX = /^(?:[\s│┃]*[—–]\s*input[\s—–]*|[\s]*[>$#%›➤]\s*)/i;

function stripInputPrompt(text: string): string {
  return text.replace(INPUT_PROMPT_PREFIX, '').trim();
}

function emptyHistory(ts: string): TerminalHistory {
  return {
    lastText: '',
    lastKey: '',
    lastTs: ts,
    consecutiveBlankCount: 0,
    lastNoiseCategory: null,
    lastFooterTs: null,
    echoBuffer: [],
    thinkingBuffer: [],
    thinkingLabel: null,
    thinkingSawBlank: false,
    thinkingLiveEmitted: false,
  };
}

export class TerminalStreamNormalizer {
  private history = new Map<string, TerminalHistory>();

  /**
   * Process one raw PTY line. Returns a normalized line to emit, or `null` if
   * the line should be dropped.
   */
  process(input: StreamLine): StreamLine | null {
    const terminalId = input.terminal_id;
    const ts = input.ts;

    let text = stripAnsi(input.line);
    text = normalizeTerminalLine(input.provider as CodeProvider, text);

    // A carriage return in the line means the provider redrew the current
    // line (e.g., progress updates). Keep only the final segment.
    if (text.includes('\r')) {
      const segments = text.split('\r');
      text = segments[segments.length - 1];
    }

    let hist = this.history.get(terminalId);

    // --- Thinking-block handling -----------------------------------------
    const isThinkingGlyphLine = THINKING_GLYPHS.test(text);
    const isThinkingLabel = THINKING_LABEL.test(text);
    // Fallback: any line that is composed solely of spinner/status glyphs and
    // whitespace should become a live thinking placeholder. This catches
    // provider-specific spinners (e.g. Kimi's colored-circle frames) whose exact
    // Unicode characters we may not have enumerated.
    const isPureSpinnerLine = text.replace(SPINNER_GLYPHS, '').trim().length === 0 && text.trim().length > 0;
    const startsThinking = isThinkingLabel || isThinkingGlyphLine || isPureSpinnerLine || THINKING_START_MARKER.test(text);
    const endsThinking = THINKING_END_MARKER.test(text);

    if (endsThinking && hist?.thinkingLabel) {
      // Explicit </thinking> ends the block with no attached answer line.
      return this.flushThinking(input, hist, null);
    }

    if (startsThinking) {
      if (!hist) {
        hist = emptyHistory(ts);
      }
      // Update the label if we are already in a thinking block, but keep the
      // accumulated content so the stream remains continuous.
      hist.thinkingLabel = isThinkingLabel ? extractThinkingLabel(text) : (hist.thinkingLabel || 'Thinking...');
      hist.thinkingLiveEmitted = true;
      this.history.set(terminalId, hist);
      return this.makeThinkingLine(input, hist);
    }

    if (hist?.thinkingLabel) {
      // Provider TUI chrome (footer bars, input separators, context counters)
      // redraws inside thinking sessions. Do not let it end thinking or leak
      // into the accumulated content; just keep the live placeholder spinning.
      const noiseCategory = classifyNoise(text);
      if (noiseCategory === 'footer' || noiseCategory === 'separator') {
        this.history.set(terminalId, hist);
        return this.makeThinkingLine(input, hist);
      }

      // Heuristic end-of-thinking: a non-blank line after we have seen at least
      // one blank line while in thinking mode is treated as the answer line.
      if (hist.thinkingSawBlank && !isBlank(text)) {
        return this.flushThinking(input, hist, text);
      }

      if (isBlank(text)) {
        hist.thinkingSawBlank = true;
      } else {
        // Accumulate thinking content, guarding against runaway buffers.
        if (hist.thinkingBuffer.length < MAX_THINKING_BUFFER_LINES) {
          hist.thinkingBuffer.push(text);
        }
      }
      this.history.set(terminalId, hist);
      return this.makeThinkingLine(input, hist);
    }

    // --- Existing normalization ------------------------------------------
    return this.processNormalLine(input, hist, text, ts);
  }

  private makeThinkingLine(input: StreamLine, hist: TerminalHistory): StreamLine {
    return {
      ...input,
      line: hist.thinkingLabel || 'Thinking...',
      thinking: hist.thinkingBuffer.slice(-5).join('\n'),
      thinkingLive: true,
    };
  }

  private flushThinking(
    input: StreamLine,
    hist: TerminalHistory,
    answerText: string | null,
  ): StreamLine {
    const label = hist.thinkingLabel || 'Thinking...';
    const thinking = hist.thinkingBuffer.join('\n');
    hist.thinkingBuffer = [];
    hist.thinkingLabel = null;
    hist.thinkingSawBlank = false;
    hist.thinkingLiveEmitted = false;
    this.history.set(input.terminal_id, hist);

    if (answerText == null) {
      // No answer line followed the thinking block. Emit a finalized
      // thinking-only line so the content is not lost.
      return { ...input, line: label, thinking, thinkingLive: false };
    }

    return { ...input, line: answerText, thinking, thinkingLive: false };
  }

  private processNormalLine(
    input: StreamLine,
    hist: TerminalHistory | undefined,
    text: string,
    ts: string,
  ): StreamLine | null {
    // Collapse consecutive blank lines to at most two to preserve visual
    // spacing without emitting long runs of empty lines.
    if (isBlank(text)) {
      const blankCount = (hist?.consecutiveBlankCount ?? 0) + 1;
      if (!hist) {
        hist = emptyHistory(ts);
        this.history.set(input.terminal_id, hist);
      }
      hist.consecutiveBlankCount = blankCount;
      return blankCount <= 2 ? { ...input, line: text } : null;
    }

    const key = collapseKey(text);
    const noiseCategory = classifyNoise(text);

    // Consecutive-frame collapse + 5-second deduplication.
    if (hist && hist.lastKey === key) {
      const prevTs = new Date(hist.lastTs).getTime();
      const now = new Date(ts).getTime();
      if (now - prevTs < DEDUP_WINDOW_MS) {
        // Refresh the timestamp so the window keeps sliding.
        hist.lastTs = ts;
        hist.lastNoiseCategory = noiseCategory;
        hist.consecutiveBlankCount = 0;
        this.history.set(input.terminal_id, hist);
        return null;
      }
    }

    // Aggressive footer suppression: provider status bars (yolo agent, context%,
    // token usage, input separators) redraw across command output and other lines.
    // Suppress any footer-like line that appears within the dedup window of the
    // last footer, regardless of intervening content.
    if (noiseCategory === 'footer' && hist && hist.lastFooterTs) {
      const prevFooterTs = new Date(hist.lastFooterTs).getTime();
      const now = new Date(ts).getTime();
      if (now - prevFooterTs < DEDUP_WINDOW_MS) {
        hist.lastTs = ts;
        hist.lastKey = key;
        hist.lastText = text;
        hist.lastNoiseCategory = noiseCategory;
        hist.consecutiveBlankCount = 0;
        this.history.set(input.terminal_id, hist);
        return null;
      }
    }

    // Interim TUI noise-family collapse: repeated status dots, "Thinking..."
    // variants, and decorative separator lines redraw continuously in interactive
    // TUIs. Drop variants of the same noise family within the same dedup window so
    // the human can follow the actual conversation. This runs *after* identical-
    // line dedup so a genuinely stale repeated line still reappears after the
    // window. Only lines that are *purely* status/thinking/separator collapse.
    if (noiseCategory && hist && hist.lastNoiseCategory === noiseCategory) {
      const prevTs = new Date(hist.lastTs).getTime();
      const now = new Date(ts).getTime();
      if (now - prevTs < DEDUP_WINDOW_MS) {
        hist.lastTs = ts;
        hist.lastKey = key;
        hist.lastText = text;
        hist.consecutiveBlankCount = 0;
        this.history.set(input.terminal_id, hist);
        return null;
      }
    }

    if (!hist) {
      hist = emptyHistory(ts);
      this.history.set(input.terminal_id, hist);
    }
    hist.lastText = text;
    hist.lastKey = key;
    hist.lastTs = ts;
    hist.consecutiveBlankCount = 0;
    hist.lastNoiseCategory = noiseCategory;
    if (noiseCategory === 'footer') {
      hist.lastFooterTs = ts;
    }

    return { ...input, line: text };
  }

  /** Drop history for a terminal (e.g. on kill/reset). */
  dropTerminal(terminalId: string): void {
    const hist = this.history.get(terminalId);
    this.history.delete(terminalId);
    if (hist?.thinkingBuffer.length) {
      // Terminal died mid-think; do not leak partial thinking into the next session.
      // We intentionally do not emit a finalized line here because there is no
      // caller to consume it. The next session starts with emptyHistory().
    }
  }

  /** Record user input sent to a terminal so echoed PTY output can be suppressed. */
  recordInput(terminalId: string, text: string, ts = new Date().toISOString()): void {
    const hist = this.history.get(terminalId);
    if (!hist) {
      this.history.set(terminalId, { ...emptyHistory(ts), echoBuffer: [{ text, ts }] });
      return;
    }
    hist.echoBuffer.push({ text, ts });
    // Prune entries older than the echo window to keep the buffer small.
    const cutoff = new Date(ts).getTime() - ECHO_WINDOW_MS;
    hist.echoBuffer = hist.echoBuffer.filter((e) => new Date(e.ts).getTime() > cutoff);
    this.history.set(terminalId, hist);
  }

  /** Reset all history. */
  clear(): void {
    this.history.clear();
  }
}

function extractThinkingLabel(text: string): string {
  const match = text.match(THINKING_LABEL);
  if (match) return text.trim();
  if (THINKING_START_MARKER.test(text)) return 'Thinking...';
  return 'Thinking...';
}

/**
 * Shared normalizer instance used by the SSE hook and renderer lifecycle cleanup.
 *
 * Keeping one instance means the deduplication/blank-collapse state persists
 * across reconnects, and terminal kill/restart paths can call `dropTerminal`
 * to reset per-terminal history so stale frames do not bleed into a fresh PTY.
 */
export const terminalStreamNormalizer = new TerminalStreamNormalizer();
