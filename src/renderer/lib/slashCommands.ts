/**
 * Slash-command parser and command metadata.
 *
 * Tokenizer respects single and double quoted strings so arguments with spaces
 * survive intact. The first token (after the leading '/') is the command name;
 * everything else is positional arguments.
 */

export interface ParsedCommand {
  /** Command name without the leading slash. */
  command: string;
  /** Positional arguments, quotes stripped. */
  args: string[];
  /** Original input string. */
  raw: string;
}

export interface CommandMeta {
  name: string;
  description: string;
  usage: string;
}

export const COMMAND_METAS: CommandMeta[] = [
  { name: 'help', description: 'Show available commands or details for one.', usage: '/help [command]' },
  { name: 'clear', description: 'Clear output for the current pane, all panes, or a named agent.', usage: '/clear [all|<agent>]' },
  { name: 'layout', description: 'Change the terminal pane layout.', usage: '/layout grid|horizontal|vertical' },
  { name: 'zoom', description: 'Focus one agent pane or restore grid.', usage: '/zoom <agent>|reset' },
  { name: 'spawn', description: 'Start the current agent.', usage: '/spawn' },
  { name: 'kill', description: 'Stop the current agent.', usage: '/kill' },
  { name: 'restart', description: 'Restart the current agent.', usage: '/restart' },
  { name: 'status', description: 'Show status for the current agent.', usage: '/status' },
  { name: 'mail', description: 'Send a mail message to another agent.', usage: '/mail <agent> "<message>"' },
  { name: 'inbox', description: 'Check mail for the current or named agent.', usage: '/inbox [agent]' },
  { name: 'unattended', description: 'Start or stop unattended mode.', usage: '/unattended start|stop' },
  { name: 'standup', description: 'Trigger or show the current standup round.', usage: '/standup' },
];

export const KNOWN_COMMANDS = new Set(COMMAND_METAS.map((c) => c.name));

/**
 * Tokenize a command line respecting single/double quotes.
 * Returns null if the input is not a slash command.
 */
export function parseCommand(input: string): ParsedCommand | null {
  const trimmed = input.trim();
  if (!trimmed.startsWith('/')) return null;

  const tokens: string[] = [];
  let i = 1; // skip leading '/'
  const len = trimmed.length;

  while (i < len) {
    // Skip leading whitespace between tokens.
    while (i < len && /\s/.test(trimmed[i])) i++;
    if (i >= len) break;

    const quote = trimmed[i];
    if (quote === '"' || quote === "'") {
      i++;
      let value = '';
      while (i < len && trimmed[i] !== quote) {
        value += trimmed[i];
        i++;
      }
      if (i < len) i++; // consume closing quote
      tokens.push(value);
    } else {
      let value = '';
      while (i < len && !/\s/.test(trimmed[i])) {
        value += trimmed[i];
        i++;
      }
      tokens.push(value);
    }
  }

  if (tokens.length === 0) return null;
  const [command, ...args] = tokens;
  return { command: command.toLowerCase(), args, raw: trimmed };
}

/**
 * Filter command metadata by a typed prefix (after the leading '/').
 */
export function filterCommands(query: string): CommandMeta[] {
  const prefix = query.startsWith('/') ? query.slice(1).toLowerCase() : query.toLowerCase();
  if (!prefix) return COMMAND_METAS;
  return COMMAND_METAS.filter(
    (c) => c.name.startsWith(prefix) || c.description.toLowerCase().includes(prefix),
  );
}

/**
 * True if the input starts with a slash and the command is known.
 */
export function isKnownCommand(input: string): boolean {
  const parsed = parseCommand(input);
  return parsed != null && KNOWN_COMMANDS.has(parsed.command);
}
