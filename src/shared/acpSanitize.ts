/**
 * Shared ACP content sanitizer.
 *
 * `kimi acp` leaks CLI status-stream fragments into ACP contentText/thinking
 * chunks (token counters, timing fragments, redraw coordinates) as well as
 * terminal mechanics (ANSI escapes, backspaces, stray CRs). This module filters
 * those artifacts while preserving legitimate prose, numbers, years, and version
 * strings.
 *
 * The design is intentionally explicit: each artifact category has a named
 * classifier instead of a single opaque regex. That makes the rules easy to
 * review, tune, and regression-test. Both the main runtime and the renderer
 * store import from here so sanitization behavior is identical on both sides of
 * the IPC boundary.
 */

// ---------------------------------------------------------------------------
// Terminal mechanics
// ---------------------------------------------------------------------------

const ANSI_OR_CONTROL =
  /\u001b\[[\d;]*[A-Za-z]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b\[[\d;]*$|\u001b$|[\x00-\x07\x0B-\x0C\x0E-\x1F\x7F]/g;

function stripAnsiAndControls(text: string): string {
  return text.replace(ANSI_OR_CONTROL, '');
}

function applyBackspaces(text: string): string {
  const chars: string[] = [];
  for (const ch of text) {
    if (ch === '\b') {
      chars.pop();
    } else {
      chars.push(ch);
    }
  }
  return chars.join('');
}

function normalizeLineEndings(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '');
}

function stripTerminalArtifacts(text: string): string {
  // Order matters: process backspaces first so they erase the characters the
  // terminal would have erased, then strip ANSI / control characters and
  // normalize CRLF/lone CRs.
  return normalizeLineEndings(stripAnsiAndControls(applyBackspaces(text)));
}

// ---------------------------------------------------------------------------
// Kimi streaming metadata artifacts
// ---------------------------------------------------------------------------

// Horizontal whitespace (spaces/tabs only) so inline replacements never swallow
// line breaks.
const HWS = '[^\\S\\r\\n]';

// Token counters with optional timing prefix:
//   "13 tokens :", "1s · 82 tokens:96", "106 tokens: : 18"
const TOKEN_COUNTER_INLINE = new RegExp(
  `(?:\\b\\d+[smh]${HWS}*[·:]${HWS}*)?\\b\\d+${HWS}*tokens?\\b(?:${HWS}*[:·]+(?:${HWS}*\\d+)?)*${HWS}*`,
  'gi',
);

function scrubInlineTokenCounters(line: string): string {
  return line.replace(TOKEN_COUNTER_INLINE, '');
}

function isTokenCounterOnlyLine(line: string): boolean {
  const scrubbed = scrubInlineTokenCounters(line);
  return scrubbed.trim().length === 0 && line.trim().length > 0;
}

function isTimeLikeArtifactLine(line: string): boolean {
  const t = line.trim();
  if (/^\d{1,3}:\d{2}(?::\d{2})?$/.test(t)) return true;
  if (/^:\d+$/.test(t)) return true;
  if (/^\d+':?$/.test(t)) return true;
  return false;
}

function isStandaloneNumberArtifactLine(line: string, contextHasArtifacts: boolean): boolean {
  if (!contextHasArtifacts) return false;
  const t = line.trim();
  // Very short (1-2 digits) or very long (5+ digits) standalone numbers are
  // almost always counters/IDs. We preserve 3-4 digit values like years
  // ("2026") or small counts ("123").
  return /^(?:\d{1,2}|\d{5,})$/.test(t);
}

/**
 * Remove Kimi CLI streaming artifacts from ACP content text.
 *
 * Input is expected to be free of terminal control sequences (ANSI escapes,
 * backspaces, stray CRs). Terminal mechanics should be stripped before calling
 * this function; use {@link sanitizeAcpDisplayText} for the full pipeline.
 */
export function sanitizeKimiContent(text: string): string {
  const lines = text.split('\n');

  // First pass: detect whether this chunk contains any obvious status artifacts.
  // That context lets us safely drop clustered standalone numeric lines without
  // removing a legitimate lone answer like "42".
  const hasObviousArtifact = lines.some(
    (line) => isTokenCounterOnlyLine(line) || isTimeLikeArtifactLine(line),
  );

  const cleanedLines = lines
    .map((line) => {
      // Drop lines that are nothing but a token counter. Keep prose lines that
      // merely contain an inline counter; the next step scrubs those fragments.
      const scrubbed = scrubInlineTokenCounters(line);
      return scrubbed.trim().length === 0 && line.trim().length > 0 ? null : scrubbed;
    })
    .filter((line): line is string => line !== null)
    .filter((line) => !isTimeLikeArtifactLine(line))
    .filter((line) => !isStandaloneNumberArtifactLine(line, hasObviousArtifact));

  // Preserve genuine paragraph breaks (double newlines) but collapse runs of
  // three or more newlines left behind by removed artifact lines.
  return cleanedLines.join('\n').replace(/\n{3,}/g, '\n\n');
}

/**
 * Full ACP display-text sanitizer used by both the runtime and the renderer.
 *
 * Combines terminal mechanics (ANSI, backspace, CR) with Kimi-specific streaming
 * metadata removal. The result is safe to render in Markdown or plain text.
 */
export function sanitizeAcpDisplayText(text: string): string {
  return sanitizeKimiContent(stripTerminalArtifacts(text));
}
