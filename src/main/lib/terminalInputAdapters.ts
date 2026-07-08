import type { TerminalProvider } from '../../shared/types';

/**
 * Build the provider-specific PTY input for an image-bearing user message.
 *
 * Phase 1 contract: write each quoted absolute image path on its own line,
 * followed by the user's text and a final newline. Claude Code, Kimi CLI, and
 * Codex CLI all detect pasted image paths by extension and attach them.
 */
export function buildImageInputCommand(
  provider: TerminalProvider,
  imagePaths: string[],
  text: string,
): string {
  if (!imagePaths.length) {
    return text ? text + '\r' : '';
  }

  const quotedPaths = imagePaths.map((p) => `"${p.replace(/"/g, '\\"')}"`).join('\n');
  const body = text.trim();

  if (!body) {
    return quotedPaths + '\r';
  }

  return `${quotedPaths}\n${body}\r`;
}
