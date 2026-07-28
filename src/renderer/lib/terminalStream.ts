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
import { useAgentStatusStore } from '../stores/agentStatusStore';

export interface CodeChangeLine {
  filePath: string;
  operation: 'modified' | 'created' | 'deleted';
  hunks: Array<{
    lines: Array<{ type: 'context' | 'add' | 'remove'; text: string; lineNumber?: number }>;
  }>;
}

export interface StreamLine {
  agent: string;
  terminal_id: string;
  provider?: string;
  line: string;
  ts: string;
  project_id?: string;
  /** Who/what produced this line: agent output, user input, or info/system. */
  source?: import('../stores/agentOutputStore').OutputSource;
  /** Accumulated thinking content associated with this line (the answer). */
  thinking?: string;
  /** When true, this line is a live thinking placeholder that should be replaced by the final answer. */
  thinkingLive?: boolean;
  /** Structured code-change payload when this line represents an edit block. */
  codeChange?: CodeChangeLine;
}

interface PendingCodeChange {
  filePath: string;
  operation: 'modified' | 'created' | 'deleted';
  lines: Array<{ type: 'context' | 'add' | 'remove'; text: string; lineNumber?: number }>;
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
  // Recent-seen structural keys with their last emission timestamp (ms). Used
  // to suppress non-consecutive duplicate lines within the dedup window, which
  // catches provider TUIs that redraw conversation history or echo input.
  recentKeys: Map<string, number>;
  // User-input lines already emitted as user-source. Provider TUIs reprint the
  // user's prompt with various prefixes long after the original echo; this map
  // lets us suppress those delayed repeats without affecting agent answers.
  emittedUserInputKeys: Map<string, number>;
  // Last time we pruned stale entries from recentKeys (ms).
  recentKeysLastPruned: number;
  // Buffered code-change block waiting for more diff lines or a flush trigger.
  pendingCodeChange: PendingCodeChange | null;
  // Thinking-block state.
  thinkingBuffer: string[];
  thinkingLabel: string | null;
  thinkingSawBlank: boolean;
  thinkingLiveEmitted: boolean;
  // Cached joined preview so heavy joins don't run on every spinner frame.
  thinkingPreview: string;
  thinkingPreviewBufferLength: number;
}

const DEDUP_WINDOW_MS = 5000;
const MAX_THINKING_BUFFER_LINES = 1000;
const RECENT_KEY_PRUNE_INTERVAL_MS = 1000;
const COLLAPSE_KEY_CACHE_SIZE = 200;

// Provider TUIs reprint user input as part of redraws, tool-use headers, and
// conversation history. Keep a longer memory of user input we already emitted
// so those delayed echoes do not repeat in the pane.
const USER_INPUT_DEDUP_WINDOW_MS = 30000;

// Common prompt prefixes provider CLIs add to echoed user input (e.g. "> ",
// "$ ", "# ", "› ", box-drawing variants).
const USER_INPUT_PROMPT_PREFIX = /^[\s│┃┣├]*[›>➤$#%?→⇒]\s+/;

function stripUserInputPrefix(text: string): string {
  return text.replace(USER_INPUT_PROMPT_PREFIX, '');
}

// When a footer/status line is split across PTY chunks or SSE events, the
// trailing fragment can leak as a short numeric line. Drop these fragments if
// they arrive within this window after a footer was suppressed.
const FOOTER_CONTINUATION_WINDOW_MS = 500;

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
const THINKING_LABEL = /^(?:[\s│┃┣├]*[›>➤]\s*(?:thinking|analyzing|analysing|processing|working|reasoning|loading|waiting|running|executing|composing)[\s\.…]*|[\s]*(?:thinking|analyzing|analysing|processing|working|reasoning|loading|waiting|running|executing|composing)[\s\.…]*|[\s]*\.{3,}[\s]*)$/i;

// Repeated separator characters emitted by provider TUIs (e.g. "--- input ---",
// "==========", "~~~~~~~~~~", "───", "━━━"). Includes ASCII separators and
// box-drawing horizontal lines.
const SEPARATOR_LINE = /^(?:[\s]*[-=~_+*#▁▂▃▄▅▆▇█─━]{3,}[\s]*)+$/;

// Provider footer / status metadata that is redrawn on every TUI frame.
// Catches context-usage lines ("context: 69.4%"), token/cost counters, Kimi
// Code CLI status bars ("yolo agent (K2.7 Code ●) ..."), input prompts, and
// repeating keybinding/help hint lines ("ctrl-x: toggle mode", "@: mention files").
// Input prompts use em-dash, en-dash, box-drawing horizontals, or a lone hyphen.
const FOOTER_LINE = /^(?:[\s|⫶·]*(?:(?:context|tokens?|usage|cost|cpu|memory|tools?|files?|calls?|provider|model)\s*[:=]\s*[\d\.,\/%\sKMBT$]+.*|yolo\s+agent\b.*|\(\d[\d\.,]*[kmbt]?\/\d[\d\.,]*[kmbt]?\).*|⫶.*|[—–─━=\-]+\s*input\b.*|composing\b.*\d+[\d\.,]*[kmbt]?\s*tokens?|(?:ctrl|shift|alt|cmd)-[a-z0-9]+:.*|ctl-x:.*|crl-v(?:paste)?.*|[@#]\s*:\s*mention files|jnewline|\/(?:feedback|theme)\b.*|(?:thme|theme)\b.*|↑.*|ctrl-s\b.*)\s*[\s|⫶·]*)+$/i;

// Kimi CLI emits transient numeric fragments during cheap-spinner/status redraws
// that survive ANSI stripping, e.g. ":275347" (spinner token counter) or "302t".
// Treat them as footer noise even when they appear without surrounding context.
const KIMI_STATUS_ARTIFACT = /^(?=[\s\S]*[:\/()kmbt])[\s]*(?::\d{3,}|\d[\d\.,]*[kmbt]?\s*(?:tokens?|t)?(?:\s+\d[\d\.,]*[kmbt]?\s*(?:tokens?|t)?)*\)?)[\s]*$/i;

// Fragments of a split footer line: token ratios and counters that leak on their
// own after a full footer was suppressed. Only active within
// FOOTER_CONTINUATION_WINDOW_MS of a dropped footer.
const FOOTER_FRAGMENT = /^(?=[\s\S]*[:\/()kmbt])[\s]*(?::\d{3,}|\d[\d\.,]*[kmbt]?\)?(?:\s+\d[\d\.,]*[kmbt]?\)?)*(?:\s*(?:tokens?|t))?|\(?\d[\d\.,]*[kmbt]?\s*\/\s*\d[\d\.,]*[kmbt]?\)?(?:\s+\d[\d\.,]*[kmbt]?\)?)*(?:\s*(?:tokens?|t))?)[\s]*$/i;

// Transient cursor-coordinate / SGR / status fragments that survive ANSI
// stripping and leak as standalone lines or prefixes, e.g. ":37", "2:12",
// "21:12", ":.8 info:", "[3", "[37m". Treat them as footer noise so they do
// not pollute the transcript.
const CHUD_ARTIFACT = /^[\s]*(?:\d{1,2}:\d{2}(?::\d{2})?|:(?:\d+(?:\.\d+)?|\.\d+)(?:\s+\w+:.*)?|\[\d[\d;]*m?)[\s]*$/i;

// Explicit XML-style thinking markers (some providers/TUIs emit these).
const THINKING_START_MARKER = /<thinking\b/i;
const THINKING_END_MARKER = /<\/thinking>/i;

// Noise categories for interim TUI noise collapse. Distinct from the structural
// collapse key because we want to suppress *families* of status lines, not just
// exact matches.
type NoiseCategory = 'status-glyph' | 'thinking' | 'separator' | 'footer';

// Code-change detection heuristics for agent-emitted file edits.
// Trigger lines name the file and operation (e.g. "Now modify TerminalPane.tsx...").
const CODE_CHANGE_MODIFY_TRIGGER = /Now modify\s+(.+?)(?:\s*(?:\.{3,}|…)\s*|$)/i;
const CODE_CHANGE_CREATE_TRIGGER = /Creating\s+(.+?)(?:\s*(?:\.{3,}|…)\s*|$)/i;
const CODE_CHANGE_DELETE_TRIGGER = /Delete\s+(.+?)(?:\s*(?:\.{3,}|…)\s*|$)/i;
const CODE_CHANGE_TOOL_MARKER = /Using\s+(?:StrReplaceFile|WriteFile)/i;

// Info/system lines that are not agent output and should be visually distinct.
const INFO_LINE_PATTERNS = [
  /^\[ACP\s+mail\]/i,
  /^Failed\s+to\s+start:/i,
  /^\[ACP\s+[a-z]+\]/i,
];

function extractCodeChangeTrigger(text: string): { filePath: string; operation: 'modified' | 'created' | 'deleted' } | null {
  const modify = text.match(CODE_CHANGE_MODIFY_TRIGGER);
  if (modify) return { filePath: modify[1].trim(), operation: 'modified' };
  const create = text.match(CODE_CHANGE_CREATE_TRIGGER);
  if (create) return { filePath: create[1].trim(), operation: 'created' };
  const del = text.match(CODE_CHANGE_DELETE_TRIGGER);
  if (del) return { filePath: del[1].trim(), operation: 'deleted' };
  return null;
}

function parseCodeChangeDiffLine(text: string): { type: 'context' | 'add' | 'remove'; text: string; lineNumber?: number } | null {
  const trimmed = text.trimStart();
  // Lines like "| 71 const foo = ..." carry a line number and optional +/- prefix.
  if (trimmed.startsWith('|')) {
    const after = trimmed.slice(1).trimStart();
    const numMatch = after.match(/^(\d+)\s+/);
    if (numMatch) {
      const lineNumber = parseInt(numMatch[1], 10);
      const rest = after.slice(numMatch[0].length);
      if (rest.startsWith('+')) {
        return { type: 'add', text: rest.slice(1).trimStart(), lineNumber };
      }
      if (rest.startsWith('-')) {
        return { type: 'remove', text: rest.slice(1).trimStart(), lineNumber };
      }
      return { type: 'context', text: rest, lineNumber };
    }
    return { type: 'context', text: after };
  }
  // Unified-diff style standalone +/- lines.
  if (trimmed.startsWith('+')) {
    return { type: 'add', text: trimmed.slice(1).trimStart() };
  }
  if (trimmed.startsWith('-')) {
    return { type: 'remove', text: trimmed.slice(1).trimStart() };
  }
  return null;
}

function isCodeChangeToolMarker(text: string): boolean {
  return CODE_CHANGE_TOOL_MARKER.test(text);
}

function classifySource(text: string): import('../stores/agentOutputStore').OutputSource {
  if (INFO_LINE_PATTERNS.some((p) => p.test(text))) return 'info';
  return 'agent';
}

// Parse token shorthand like 1.2k, 140, 262.1k into a raw number.
function parseTokens(value: string): number {
  const cleaned = value.trim().toLowerCase().replace(/,/g, '');
  const match = cleaned.match(/^(\d+(?:\.\d+)?)\s*([kmbt])?$/);
  if (!match) return NaN;
  const num = parseFloat(match[1]);
  const suffix = match[2];
  switch (suffix) {
    case 'k': return Math.round(num * 1_000);
    case 'm': return Math.round(num * 1_000_000);
    case 'b': return Math.round(num * 1_000_000_000);
    case 't': return Math.round(num * 1_000_000_000_000);
    default: return Math.round(num);
  }
}

interface StatusExtract {
  contextUsage?: number;
  tokenUsed?: number;
  tokenMax?: number;
  cwd?: string;
  model?: string;
  composing?: { duration: string; tokens: number } | null;
}

const STATUS_EXTRACTORS: { regex: RegExp; extract: (m: RegExpMatchArray) => StatusExtract | null }[] = [
  // context: 38.5%
  {
    regex: /context\s*[:=]\s*(\d+(?:\.\d+)?)\s*%/i,
    extract: (m) => ({ contextUsage: parseFloat(m[1]) }),
  },
  // (101.9k/262.1k)
  {
    regex: /\(\s*(\d[\d\.,]*[kmbt]?)\s*\/\s*(\d[\d\.,]*[kmbt]?)\s*\)/i,
    extract: (m) => {
      const used = parseTokens(m[1]);
      const max = parseTokens(m[2]);
      return {
        tokenUsed: Number.isNaN(used) ? undefined : used,
        tokenMax: Number.isNaN(max) ? undefined : max,
      };
    },
  },
  // yolo agent (K2.7 Code •) E:\repos ...
  {
    regex: /yolo\s+agent\s*\(\s*([^)]+?)\s*(?:•|\*)\s*\)\s*(.+?)(?=\s+(?:ctrl|shift|alt|cmd)-[a-z0-9]+:|$)/i,
    extract: (m) => {
      const model = m[1].trim();
      const cwd = m[2].trim();
      return { model: model || undefined, cwd: cwd || undefined };
    },
  },
  // Composing... <1s · 140 tokens
  {
    regex: /composing[\s\.…]*([<]?\d+[smh]?)\s*[·.]?\s*(\d[\d\.,]*[kmbt]?)\s*tokens?/i,
    extract: (m) => {
      const tokens = parseTokens(m[2]);
      return {
        composing: {
          duration: m[1].trim(),
          tokens: Number.isNaN(tokens) ? 0 : tokens,
        },
      };
    },
  },
];

function extractStatus(text: string): StatusExtract | null {
  for (const { regex, extract } of STATUS_EXTRACTORS) {
    const m = text.match(regex);
    if (m) {
      const result = extract(m);
      if (result) return result;
    }
  }
  return null;
}

function updateAgentStatus(agentName: string, extract: StatusExtract | null) {
  if (!agentName || !extract) return;
  const update: Record<string, unknown> = {};
  if (extract.contextUsage !== undefined) update.contextUsage = extract.contextUsage;
  if (extract.tokenUsed !== undefined) update.tokenUsed = extract.tokenUsed;
  if (extract.tokenMax !== undefined) update.tokenMax = extract.tokenMax;
  if (extract.cwd !== undefined) update.cwd = extract.cwd;
  if (extract.model !== undefined) update.model = extract.model;
  if (extract.composing !== undefined) update.composing = extract.composing;
  if (Object.keys(update).length > 0) {
    useAgentStatusStore.getState().setStatus(agentName, update);
  }
}

/**
 * Status extraction for screen-model frame lines. Frame-backed terminals skip
 * the cloud SSE path, so footer lines inside the live screen region feed the
 * agent-status store here instead of via process().
 */
export function extractStatusFromFrameLine(agentName: string, text: string): void {
  if (!agentName || !text) return;
  if (classifyNoise(text) === 'footer') {
    updateAgentStatus(agentName, extractStatus(text));
  }
}

class LruCache<K, V> {
  private cache = new Map<K, V>();
  constructor(private readonly maxSize: number) {}
  get(key: K): V | undefined {
    const value = this.cache.get(key);
    if (value !== undefined) {
      // Move to back (most recently used).
      this.cache.delete(key);
      this.cache.set(key, value);
    }
    return value;
  }
  set(key: K, value: V): void {
    if (this.cache.has(key)) this.cache.delete(key);
    else if (this.cache.size >= this.maxSize) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    this.cache.set(key, value);
  }
}

const collapseKeyCache = new LruCache<string, string>(COLLAPSE_KEY_CACHE_SIZE);

function collapseKey(text: string): string {
  const cached = collapseKeyCache.get(text);
  if (cached !== undefined) return cached;
  const key = text
    .replace(SPINNER_GLYPHS, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  collapseKeyCache.set(text, key);
  return key;
}

function classifyNoise(text: string): NoiseCategory | null {
  // Check separator first so that repeated dash/pipe patterns (e.g. '---',
  // '==========') are treated as decorative separators, not status glyphs.
  if (SEPARATOR_LINE.test(text)) return 'separator';
  // Footer/status metadata is redrawn continuously (context %, token counters,
  // cost summaries). Treat as a family so numeric variants collapse.
  if (FOOTER_LINE.test(text)) return 'footer';
  // Kimi CLI cheap-spinner numeric artifacts (e.g. ":275347", "302t") are
  // status noise even when they appear as standalone fragments.
  if (KIMI_STATUS_ARTIFACT.test(text)) return 'footer';
  // Residual ANSI/TUI fragments like ":37", "2:12", ":.8 info:", "[3" that
  // survive stripping and appear as standalone lines.
  if (CHUD_ARTIFACT.test(text)) return 'footer';
  if (STATUS_GLYPHS.test(text)) return 'status-glyph';
  if (THINKING_LABEL.test(text)) return 'thinking';
  return null;
}

function isBlank(text: string): boolean {
  return text.trim().length === 0;
}

function emptyHistory(ts: string): TerminalHistory {
  return {
    lastText: '',
    lastKey: '',
    lastTs: ts,
    consecutiveBlankCount: 0,
    lastNoiseCategory: null,
    lastFooterTs: null,
    recentKeys: new Map(),
    emittedUserInputKeys: new Map(),
    recentKeysLastPruned: 0,
    pendingCodeChange: null,
    thinkingBuffer: [],
    thinkingLabel: null,
    thinkingSawBlank: false,
    thinkingLiveEmitted: false,
    thinkingPreview: '',
    thinkingPreviewBufferLength: 0,
  };
}

export class TerminalStreamNormalizer {
  private history = new Map<string, TerminalHistory>();
  // A line produced while flushing a code-change block that must be emitted
  // after the structured card. Callers should drain after each process() call.
  private deferredLine: StreamLine | null = null;
  // Recent user inputs keyed by terminal. If a PTY echo matches one of these
  // within a short window, the echoed line is tagged as user-source so it is
  // visually distinct from agent output.
  private recentUserInputs = new Map<string, { text: string; ts: number }[]>();
  private readonly USER_INPUT_WINDOW_MS = 2000;

  /**
   * Process one raw PTY line. Returns a normalized line to emit, or `null` if
   * the line should be dropped. Call drain() after each process() to retrieve
   * any additional line that was deferred (e.g., a normal line following a
   * flushed code-change block).
   */
  process(input: StreamLine): StreamLine | null {
    const terminalId = input.terminal_id;
    const ts = input.ts;

    let text = stripAnsi(input.line);
    text = normalizeTerminalLine(input.provider as CodeProvider, text);

    // Some provider TUIs emit colon-prefixed numeric fragments at line start
    // that survive ANSI stripping, e.g. ":32Actually..." or "\.6 to fix...".
    // Strip the prefix so the real content reaches the pane, but only when the
    // whole line is not itself a chud artifact (":0.8 info:" should still be
    // dropped entirely).
    if (!CHUD_ARTIFACT.test(text)) {
      text = text.replace(/^[\s]*:(?:\d+(?:\.\d+)?|\.\d+)\s*/, '');
    }


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
        if (noiseCategory === 'footer') {
          updateAgentStatus(input.agent, extractStatus(text));
        }
        this.history.set(terminalId, hist);
        return this.makeThinkingLine(input, hist);
      }

      // Heuristic end-of-thinking: a non-blank line after we have seen at least
      // one blank line while in thinking mode is treated as the answer line.
      // Cursor/line-number artifacts (e.g. "78", "50:", "3:", ":32", "\.6") that
      // leak between thinking lines must not fracture the block into single-line
      // noise stacks.
      const THINKING_ARTIFACT = /^[\s]*(?::(?:\d+(?:\.\d+)?|\.\d+)|\d+[:]?)[\s]*$/;
      if (hist.thinkingSawBlank && !isBlank(text)) {
        if (THINKING_ARTIFACT.test(text)) {
          hist.thinkingBuffer.push(text);
          // Keep thinkingSawBlank true so the next real line still flushes.
          this.history.set(terminalId, hist);
          return this.makeThinkingLine(input, hist);
        }
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

    // --- Code-change block handling --------------------------------------
    // Skip code-change detection while a thinking block is active; thinking
    // content is accumulated separately and attached to the answer line.
    if (!hist?.thinkingLabel) {
      // Blank lines end a pending code-change block, but the blank line itself
      // is dropped so it does not push real conversation out of view.
      if (isBlank(text)) {
        const flushed = this.flushPendingCodeChange(input, hist);
        if (flushed) {
          this.deferredLine = null;
          return flushed;
        }
        return null;
      }

      const trigger = extractCodeChangeTrigger(text);
      if (trigger) {
        const flushed = this.flushPendingCodeChange(input, hist);
        if (!hist) {
          hist = emptyHistory(ts);
        }
        hist.pendingCodeChange = { filePath: trigger.filePath, operation: trigger.operation, lines: [] };
        this.history.set(terminalId, hist);
        return flushed;
      }

      const diffLine = parseCodeChangeDiffLine(text);
      if (diffLine) {
        if (hist?.pendingCodeChange) {
          hist.pendingCodeChange.lines.push(diffLine);
          this.history.set(terminalId, hist);
          return null;
        }
        // No pending block: fall through to normal processing.
      }

      if (isCodeChangeToolMarker(text)) {
        const flushed = this.flushPendingCodeChange(input, hist);
        // Tool markers themselves are dropped.
        return flushed;
      }

      const flushed = this.flushPendingCodeChange(input, hist);
      const normalResult = this.processNormalLine(input, hist, text, ts);
      if (flushed) {
        this.deferredLine = normalResult;
        return flushed;
      }
      return normalResult;
    }

    // --- Existing normalization ------------------------------------------
    return this.processNormalLine(input, hist, text, ts);
  }

  /**
   * Return any line that was deferred during the last process() call. Callers
   * should invoke this after every process() and emit the result if non-null.
   */
  drain(): StreamLine | null {
    const line = this.deferredLine;
    this.deferredLine = null;
    return line;
  }

  private flushPendingCodeChange(input: StreamLine, hist: TerminalHistory | undefined): StreamLine | null {
    if (!hist?.pendingCodeChange || hist.pendingCodeChange.lines.length === 0) {
      if (hist) {
        hist.pendingCodeChange = null;
        this.history.set(input.terminal_id, hist);
      }
      return null;
    }
    const { filePath, operation, lines } = hist.pendingCodeChange;
    hist.pendingCodeChange = null;
    this.history.set(input.terminal_id, hist);
    return {
      ...input,
      line: `${operation.charAt(0).toUpperCase() + operation.slice(1)}: ${filePath}`,
      codeChange: {
        filePath,
        operation,
        hunks: [{ lines }],
      },
    };
  }

  private makeThinkingLine(input: StreamLine, hist: TerminalHistory): StreamLine {
    // Cache the joined preview and invalidate only when the buffer changes.
    const bufferLength = hist.thinkingBuffer.length;
    let preview = hist.thinkingPreview;
    if (hist.thinkingPreviewBufferLength !== bufferLength) {
      preview = hist.thinkingBuffer.slice(-5).join('\n');
      hist.thinkingPreview = preview;
      hist.thinkingPreviewBufferLength = bufferLength;
      this.history.set(input.terminal_id, hist);
    }
    return {
      ...input,
      line: hist.thinkingLabel || 'Thinking...',
      thinking: preview,
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
    // Drop blank/whitespace-only lines entirely. Provider TUIs emit many
    // invisible redraw frames; emitting even one or two blanks pushes real
    // conversation up and breaks scrolling in the virtualized pane.
    if (isBlank(text)) {
      return null;
    }

    const key = collapseKey(text);
    const noiseCategory = classifyNoise(text);

    // Aggressive TUI chrome suppression: provider status bars, context/token
    // counters, input separators, keybinding hints, yolo agent banners, and pure
    // status-glyph lines must never reach the user-facing pane stream. Drop them
    // immediately rather than emitting the first variant and deduplicating the rest.
    // NOTE: do not reset consecutiveBlankCount here; blank lines on either side of
    // a suppressed line are still visually consecutive in the rendered output, so
    // collapsing must continue across suppressed noise.
    if (noiseCategory === 'footer' || noiseCategory === 'separator' || noiseCategory === 'status-glyph') {
      if (!hist) {
        hist = emptyHistory(ts);
        this.history.set(input.terminal_id, hist);
      }
      hist.lastText = text;
      hist.lastKey = key;
      hist.lastTs = ts;
      hist.lastNoiseCategory = noiseCategory;
      if (noiseCategory === 'footer') {
        hist.lastFooterTs = ts;
        updateAgentStatus(input.agent, extractStatus(text));
      }
      this.history.set(input.terminal_id, hist);
      return null;
    }

    // Footer continuation suppression: provider status lines sometimes split
    // across PTY chunks or SSE events (e.g. "context: 63.5% (166.5k/" followed by
    // "262.1k) 302t"). The trailing fragment is not a footer on its own, so drop
    // short numeric/token fragments that arrive soon after a suppressed footer.
    if (hist?.lastFooterTs) {
      const now = new Date(ts).getTime();
      const elapsed = now - new Date(hist.lastFooterTs).getTime();
      if (elapsed >= 0 && elapsed <= FOOTER_CONTINUATION_WINDOW_MS && FOOTER_FRAGMENT.test(text)) {
        hist.lastFooterTs = ts;
        hist.lastText = text;
        hist.lastKey = key;
        hist.lastTs = ts;
        hist.lastNoiseCategory = noiseCategory;
        this.history.set(input.terminal_id, hist);
        return null;
      }
    }

    // Recent-seen deduplication: suppress the same structural key if it was
    // emitted within the sliding window, even if other lines came in between.
    // Provider TUIs (especially Claude Code) redraw conversation history and
    // echo user input repeatedly; this prevents those redraws from spamming the
    // pane. The timestamp is refreshed on every duplicate so the window slides
    // while the provider keeps redrawing the same content.
    // Pruning the map is O(n); do it at most once per second per terminal.
    if (hist) {
      const now = new Date(ts).getTime();
      if (now - hist.recentKeysLastPruned > RECENT_KEY_PRUNE_INTERVAL_MS) {
        hist.recentKeysLastPruned = now;
        for (const [k, t] of hist.recentKeys.entries()) {
          if (now - t > DEDUP_WINDOW_MS) {
            hist.recentKeys.delete(k);
          }
        }
        for (const [k, t] of hist.emittedUserInputKeys.entries()) {
          if (now - t > USER_INPUT_DEDUP_WINDOW_MS) {
            hist.emittedUserInputKeys.delete(k);
          }
        }
      }
      const lastSeen = hist.recentKeys.get(key);
      if (lastSeen != null && now - lastSeen < DEDUP_WINDOW_MS) {
        hist.recentKeys.set(key, now);
        hist.lastText = text;
        hist.lastKey = key;
        hist.lastTs = ts;
        hist.lastNoiseCategory = noiseCategory;
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
    hist.recentKeys.set(key, new Date(ts).getTime());

    const userInput = this.matchUserInput(input.terminal_id, text, ts);
    const source = userInput ? 'user' : classifySource(text);

    // Remember user input we emitted so provider TUIs that reprint it later
    // (tool headers, conversation redraws, prompt echoes) don't repeat it.
    // We check both the raw line and the prefix-stripped line so "> message"
    // echoes match the originally recorded "message".
    const emittedNow = new Date(ts).getTime();
    const strippedText = stripUserInputPrefix(text);
    const rawKey = collapseKey(text);
    const strippedKey = collapseKey(strippedText);
    if (source === 'user') {
      hist.emittedUserInputKeys.set(rawKey, emittedNow);
      hist.emittedUserInputKeys.set(strippedKey, emittedNow);
    } else {
      const emittedRaw = hist.emittedUserInputKeys.get(rawKey);
      const emittedStripped = hist.emittedUserInputKeys.get(strippedKey);
      if (
        (emittedRaw != null && emittedNow - emittedRaw < USER_INPUT_DEDUP_WINDOW_MS) ||
        (emittedStripped != null && emittedNow - emittedStripped < USER_INPUT_DEDUP_WINDOW_MS)
      ) {
        hist.lastText = text;
        hist.lastKey = key;
        hist.lastTs = ts;
        hist.lastNoiseCategory = noiseCategory;
        this.history.set(input.terminal_id, hist);
        return null;
      }
    }

    hist.consecutiveBlankCount = 0;
    this.history.set(input.terminal_id, hist);
    return { ...input, line: text, source };
  }

  /**
   * Record text the user sent to a terminal so echoed input can be tagged as
   * user-source instead of agent output.
   */
  recordUserInput(terminalId: string, text: string, ts = Date.now()): void {
    const inputs = this.recentUserInputs.get(terminalId) ?? [];
    inputs.push({ text, ts });
    // Prune stale entries.
    const cutoff = ts - this.USER_INPUT_WINDOW_MS;
    const filtered = inputs.filter((i) => i.ts >= cutoff);
    this.recentUserInputs.set(terminalId, filtered);
  }

  /**
   * Register user input that has already been rendered deterministically (e.g.
   * injected as a user-source line by the composer). Any later PTY echo of the
   * same text — with or without a prompt prefix — is suppressed rather than
   * re-rendered as agent output.
   */
  suppressEcho(terminalId: string, text: string, ts = Date.now()): void {
    let hist = this.history.get(terminalId);
    if (!hist) {
      hist = emptyHistory(new Date(ts).toISOString());
      this.history.set(terminalId, hist);
    }
    const rawKey = collapseKey(text);
    const strippedKey = collapseKey(stripUserInputPrefix(text));
    hist.emittedUserInputKeys.set(rawKey, ts);
    hist.emittedUserInputKeys.set(strippedKey, ts);
    hist.recentKeys.set(rawKey, ts);
    hist.recentKeys.set(strippedKey, ts);
    this.history.set(terminalId, hist);
  }

  private matchUserInput(terminalId: string, text: string, ts: string): string | null {
    const inputs = this.recentUserInputs.get(terminalId);
    if (!inputs || inputs.length === 0) return null;
    const now = new Date(ts).getTime();
    const cutoff = now - this.USER_INPUT_WINDOW_MS;
    const normalizedRaw = collapseKey(text);
    const normalizedStripped = collapseKey(stripUserInputPrefix(text));
    for (let i = inputs.length - 1; i >= 0; i--) {
      const input = inputs[i];
      if (input.ts < cutoff) continue;
      const inputKeyRaw = collapseKey(input.text);
      const inputKeyStripped = collapseKey(stripUserInputPrefix(input.text));
      if (
        inputKeyRaw === normalizedRaw ||
        inputKeyStripped === normalizedStripped ||
        input.text === text
      ) {
        inputs.splice(i, 1);
        return input.text;
      }
    }
    return null;
  }

  /** Drop history for a terminal (e.g. on kill/reset). */
  dropTerminal(terminalId: string): void {
    const hist = this.history.get(terminalId);
    this.history.delete(terminalId);
    this.recentUserInputs.delete(terminalId);
    if (hist?.thinkingBuffer.length) {
      // Terminal died mid-think; do not leak partial thinking into the next session.
      // We intentionally do not emit a finalized line here because there is no
      // caller to consume it. The next session starts with emptyHistory().
    }
  }

  /** Reset all history. */
  clear(): void {
    this.history.clear();
    this.recentUserInputs.clear();
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
