/**
 * Terminal provider adapters.
 *
 * These adapters operate on **plain text** after ANSI escape sequences have
 * been stripped upstream (see `src/renderer/lib/ansi.ts`). They normalize
 * provider-specific structural quirks before lines reach `agentOutputStore`.
 *
 * Phase 1 scope:
 *   - Remove leading Unicode spinner glyphs.
 *   - Replace Kimi `[IMAGE: ...]` placeholders with `⟨image⟩`.
 *   - Normalize Codex model labels (`codex-mini`, `codex-mini-latest`) to `Codex`.
 *   - Trim trailing whitespace.
 *
 * Out of scope:
 *   - ANSI parsing (handled upstream).
 *   - Full VT100/ANSI emulator.
 *   - Cursor positioning, alternate screen buffer, mouse tracking.
 */

import { type CodeProvider } from './agentProviders';

export interface TerminalAdapter {
  readonly provider: CodeProvider;

  /**
   * Transform one plain-text PTY line into normalized display text.
   * The result may still contain Unicode box-drawing or checkmark characters.
   */
  normalizeLine(line: string): string;
}

// Common braille/progress spinner glyphs used by Claude, Kimi, and Codex.
// These are Unicode characters, not ANSI escapes, so they survive upstream
// ANSI stripping and must be handled here.
const SPINNER_PREFIX = /^[\s]*(?:⠋|⠙|⠹|⠸|⠼|⠴|⠦|⠧|⠇|⠏|⠛|⠶|⠮|⠵|◐|◓|◑|◒|◉)[\s]*\s*/;

/** Remove a leading spinner glyph. */
function stripSpinnerPrefix(input: string): string {
  return input.replace(SPINNER_PREFIX, '');
}

function commonNormalize(input: string): string {
  return stripSpinnerPrefix(input).trimEnd();
}

const CLAUDE_ADAPTER: TerminalAdapter = {
  provider: 'claude',

  normalizeLine(input: string): string {
    return commonNormalize(input);
  },
};

// Kimi emits inline image placeholders like [IMAGE: filename.png].
const KIMI_IMAGE_PLACEHOLDER = /\[IMAGE:[^\]]*\]/gi;
// Normalize plain Markdown unordered-list bullets to the bullet used by the
// native Kimi CLI renderer (pi-tui uses •). This makes transcript-style lists
// consistent in the pane even when the raw PTY uses dashes or asterisks.
const KIMI_BULLET_LIST = /^(\s*)[-*](\s)/gm;

const KIMI_ADAPTER: TerminalAdapter = {
  provider: 'kimi',

  normalizeLine(input: string): string {
    return stripSpinnerPrefix(input)
      .replace(KIMI_IMAGE_PLACEHOLDER, '⟨image⟩')
      .replace(KIMI_BULLET_LIST, '$1•$2')
      .trimEnd();
  },
};

// Codex emits model labels that should be normalized to the product name.
const CODEX_MODEL_LABELS = /\bcodex-mini(?:-latest)?\b/gi;

const CODEX_ADAPTER: TerminalAdapter = {
  provider: 'codex',

  normalizeLine(input: string): string {
    return stripSpinnerPrefix(input).replace(CODEX_MODEL_LABELS, 'Codex').trimEnd();
  },
};

const ADAPTERS: Record<CodeProvider, TerminalAdapter> = {
  claude: CLAUDE_ADAPTER,
  kimi: KIMI_ADAPTER,
  codex: CODEX_ADAPTER,
};

/**
 * Get the adapter for a provider.
 * Falls back to the Claude adapter (common normalization) for unknown values.
 */
export function getTerminalAdapter(provider: CodeProvider | string | undefined): TerminalAdapter {
  if (provider === 'claude' || provider === 'kimi' || provider === 'codex') {
    return ADAPTERS[provider];
  }
  return CLAUDE_ADAPTER;
}

/**
 * Normalize a plain-text PTY line for a provider.
 * Convenience wrapper around getTerminalAdapter(provider).normalizeLine.
 */
export function normalizeTerminalLine(provider: CodeProvider | string | undefined, line: string): string {
  return getTerminalAdapter(provider).normalizeLine(line);
}
