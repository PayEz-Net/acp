/**
 * Renderer-side ACP prose guard.
 *
 * This is a second line of defense: the main runtime already sanitizes ACP
 * content, but any metadata that leaks through (token counters, timing fragments,
 * ANSI/CR leftovers) is filtered here before it reaches the DOM. The store is not
 * mutated; filtering happens at render time.
 */

import { sanitizeAcpDisplayText } from '@shared/acpSanitize';

function dedupeConsecutiveParagraphs(text: string): string {
  const paragraphs = text.split('\n\n');
  const deduped: string[] = [];
  let previous = '';
  for (const paragraph of paragraphs) {
    const normalized = paragraph.replace(/\n+/g, ' ').trim();
    if (normalized.length === 0) continue;
    if (normalized === previous) continue;
    deduped.push(paragraph.trim());
    previous = normalized;
  }
  return deduped.join('\n\n');
}


/**
 * Filter ACP text for safe rendering in the transcript.
 *
 * Applies terminal/metadata sanitization and collapses consecutive duplicate
 * paragraphs so leaked status lines or repeated chunks do not render as regular
 * assistant prose.
 */
export function filterAcpProse(text: string): string {
  const sanitized = sanitizeAcpDisplayText(text);
  return dedupeConsecutiveParagraphs(sanitized);
}
