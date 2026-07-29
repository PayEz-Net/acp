/**
 * Claude Code `stream-json` → ACP session-update mapper (WO-G4).
 *
 * Claude Code ships a structured mode:
 *
 *   claude -p --output-format stream-json --input-format stream-json \
 *          --verbose --include-partial-messages
 *
 * which emits newline-delimited JSON instead of painting a TUI. This module
 * translates that wire format into the {@link AcpSessionUpdate} vocabulary
 * `AcpRuntimeManager` already emits, so the renderer needs no Claude-specific
 * knowledge.
 *
 * IMPORTANT — this is NOT the ACP/JSON-RPC shape. Claude's stream-json is a
 * different protocol that merely happens to also be JSON: there is no
 * `jsonrpc` envelope, no request ids, and no `session/update` method. Every
 * shape below was read off the wire from real `claude` 2.1.220 runs and is
 * pinned by fixtures in `claudeStreamJson.test.ts`. Do not "tidy" it against
 * the ACP spec.
 *
 * Wire vocabulary actually observed (2026-07-29):
 *   system/hook_started · system/hook_response · system/init · system/status
 *   stream_event  (message_start, content_block_start, content_block_delta,
 *                  content_block_stop, message_delta, message_stop)
 *   assistant · user · rate_limit_event · result/success
 */

import type {
  AcpAgentCapabilities,
  AcpSessionUpdate,
  AcpToolCallStatus,
} from '../../shared/acpTypes';

/** A single parsed line of Claude's stream-json output. */
export interface ClaudeStreamJsonEvent {
  type: string;
  subtype?: string;
  session_id?: string;
  [key: string]: unknown;
}

/** Spawn args for Claude's structured mode.
 *
 * `-p` is REQUIRED: `--input-format`/`--output-format` are documented as
 * "only works with --print", and the process exits immediately without it.
 * `--include-partial-messages` is REQUIRED for token-level streaming; without
 * it Claude emits only whole assistant messages and the pane never types.
 */
export const CLAUDE_STREAM_JSON_ARGS = [
  '-p',
  '--output-format',
  'stream-json',
  '--input-format',
  'stream-json',
  '--verbose',
  '--include-partial-messages',
] as const;

/**
 * Encode a user turn for Claude's `--input-format stream-json` stdin.
 * One NDJSON line per turn; a single process serves sequential turns.
 */
export function encodeUserTurn(text: string): string {
  return `${JSON.stringify({
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text }] },
  })}\n`;
}

function truncate(text: string, max = 2000): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

/** tool_result content is a string or an array of content blocks. */
function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        const p = part as { type?: string; text?: string };
        return p?.type === 'text' && typeof p.text === 'string' ? p.text : '';
      })
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

/**
 * Stateful because the wire format is stateful: a tool call's name arrives on
 * `content_block_start` while its result arrives later keyed only by id, and
 * streamed text must be de-duplicated against the whole-message echo.
 *
 * One mapper per session. Not reusable across sessions.
 */
export class ClaudeStreamJsonMapper {
  private sessionId = '';

  /** toolCallId → human title (the tool name), learned at content_block_start. */
  private readonly toolTitles = new Map<string, string>();

  /**
   * Indices of content blocks that streamed at least one text/thinking delta.
   * Claude re-sends the COMPLETE text in a following `assistant` message; if we
   * mapped both, every reply would appear twice in the pane. We stream the
   * deltas (live typing) and drop the echo.
   */
  private readonly streamedBlocks = new Set<number>();

  /** True once any delta streamed for the current assistant message. */
  private sawTextDelta = false;

  getSessionId(): string {
    return this.sessionId;
  }

  /** Map one wire event to zero or more session updates. */
  map(event: ClaudeStreamJsonEvent): AcpSessionUpdate[] {
    if (typeof event?.type !== 'string') return [];
    if (typeof event.session_id === 'string' && event.session_id) {
      this.sessionId = event.session_id;
    }

    switch (event.type) {
      case 'system':
        return this.mapSystem(event);
      case 'stream_event':
        return this.mapStreamEvent(event);
      case 'assistant':
        return this.mapAssistant(event);
      case 'user':
        return this.mapUser(event);
      case 'result':
        return this.mapResult(event);
      // Billing telemetry, not turn output — deliberately dropped so it never
      // reaches the pane.
      case 'rate_limit_event':
        return [];
      default:
        return [];
    }
  }

  private mapSystem(event: ClaudeStreamJsonEvent): AcpSessionUpdate[] {
    if (event.subtype === 'init') {
      const capabilities: AcpAgentCapabilities = {
        promptCapabilities: { image: true, embeddedContext: true },
      };
      const updates: AcpSessionUpdate[] = [
        {
          sessionUpdate: 'initialized',
          sessionId: this.sessionId,
          capabilities,
          agentInfo: {
            name: 'Claude Code',
            version:
              typeof event.claude_code_version === 'string'
                ? event.claude_code_version
                : undefined,
          },
          imageIn: true,
        },
      ];

      const commands = event.slash_commands;
      if (Array.isArray(commands) && commands.length > 0) {
        updates.push({
          sessionUpdate: 'available_commands_update',
          sessionId: this.sessionId,
          availableCommands: commands
            .filter((c): c is string => typeof c === 'string')
            .map((name) => ({ name, description: '' })),
        });
      }
      return updates;
    }

    // `status: 'requesting'` marks an in-flight model request with no output
    // yet — the same condition kimi reports as `awaiting_first_token`. Mapping
    // it keeps the pane's activity indicator honest during provider latency.
    if (event.subtype === 'status' && event.status === 'requesting') {
      return [
        {
          sessionUpdate: 'wait_state',
          sessionId: this.sessionId,
          waitState: { kind: 'awaiting_first_token' },
        },
      ];
    }

    // hook_started / hook_response are local hook plumbing, not agent output.
    return [];
  }

  private mapStreamEvent(event: ClaudeStreamJsonEvent): AcpSessionUpdate[] {
    const inner = event.event as
      | {
          type?: string;
          index?: number;
          content_block?: { type?: string; id?: string; name?: string };
          delta?: { type?: string; text?: string; thinking?: string };
        }
      | undefined;
    if (!inner?.type) return [];

    switch (inner.type) {
      case 'message_start':
        this.sawTextDelta = false;
        this.streamedBlocks.clear();
        return [];

      case 'content_block_start': {
        const block = inner.content_block;
        if (block?.type === 'tool_use' && block.id) {
          const title = block.name ?? 'tool';
          this.toolTitles.set(block.id, title);
          // Emitted at START so the pane shows the tool the moment Claude
          // commits to it, rather than after its arguments finish streaming.
          return [
            {
              sessionUpdate: 'tool_call',
              sessionId: this.sessionId,
              toolCall: {
                toolCallId: block.id,
                title,
                status: 'in_progress',
                content: [],
              },
            },
          ];
        }
        return [];
      }

      case 'content_block_delta': {
        const delta = inner.delta;
        const index = typeof inner.index === 'number' ? inner.index : 0;

        if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
          this.streamedBlocks.add(index);
          this.sawTextDelta = true;
          return [
            {
              sessionUpdate: 'agent_message_chunk',
              sessionId: this.sessionId,
              content: { type: 'content', content: { type: 'text', text: delta.text } },
            },
          ];
        }

        if (delta?.type === 'thinking_delta' && typeof delta.thinking === 'string') {
          this.streamedBlocks.add(index);
          this.sawTextDelta = true;
          return [
            {
              sessionUpdate: 'agent_thought_chunk',
              sessionId: this.sessionId,
              content: { type: 'content', content: { type: 'text', text: delta.thinking } },
            },
          ];
        }

        // input_json_delta streams a tool's arguments. Deliberately dropped:
        // partial JSON is unreadable, and the complete input arrives on the
        // following `assistant` message as a tool_call_update.
        return [];
      }

      default:
        // content_block_stop / message_delta / message_stop carry stop reasons
        // and usage that `result` reports authoritatively.
        return [];
    }
  }

  private mapAssistant(event: ClaudeStreamJsonEvent): AcpSessionUpdate[] {
    const content = (event.message as { content?: unknown[] } | undefined)?.content;
    if (!Array.isArray(content)) return [];
    const updates: AcpSessionUpdate[] = [];

    for (const raw of content) {
      const part = raw as {
        type?: string;
        text?: string;
        thinking?: string;
        id?: string;
        name?: string;
        input?: unknown;
      };

      if (part.type === 'text' && typeof part.text === 'string') {
        // Skip the echo of text we already streamed as deltas (see
        // `streamedBlocks`). Only emit when partial messages were absent —
        // i.e. the caller omitted --include-partial-messages — so the pane
        // still shows the reply rather than nothing.
        if (!this.sawTextDelta && part.text) {
          updates.push({
            sessionUpdate: 'agent_message_chunk',
            sessionId: this.sessionId,
            content: { type: 'content', content: { type: 'text', text: part.text } },
          });
        }
        continue;
      }

      if (part.type === 'tool_use' && part.id) {
        const title = part.name ?? this.toolTitles.get(part.id) ?? 'tool';
        this.toolTitles.set(part.id, title);
        // Arguments are now complete — update the call already shown.
        const args = part.input && Object.keys(part.input as object).length > 0
          ? truncate(JSON.stringify(part.input))
          : '';
        updates.push({
          sessionUpdate: 'tool_call_update',
          sessionId: this.sessionId,
          toolCall: {
            toolCallId: part.id,
            title,
            status: 'in_progress',
            content: args
              ? [{ type: 'content', content: { type: 'text', text: args } }]
              : [],
            contentText: args || undefined,
          },
        });
      }
    }

    return updates;
  }

  /** `user` events carry tool RESULTS, not human input. */
  private mapUser(event: ClaudeStreamJsonEvent): AcpSessionUpdate[] {
    const content = (event.message as { content?: unknown[] } | undefined)?.content;
    if (!Array.isArray(content)) return [];
    const updates: AcpSessionUpdate[] = [];

    for (const raw of content) {
      const part = raw as {
        type?: string;
        tool_use_id?: string;
        content?: unknown;
        is_error?: boolean;
      };
      if (part.type !== 'tool_result' || !part.tool_use_id) continue;

      const status: AcpToolCallStatus = part.is_error ? 'failed' : 'completed';
      const text = truncate(toolResultText(part.content));
      updates.push({
        sessionUpdate: 'tool_call_update',
        sessionId: this.sessionId,
        toolCall: {
          toolCallId: part.tool_use_id,
          title: this.toolTitles.get(part.tool_use_id) ?? 'tool',
          status,
          content: text ? [{ type: 'content', content: { type: 'text', text } }] : [],
          contentText: text || undefined,
        },
      });
    }

    return updates;
  }

  /**
   * Settle a turn the client cancelled (ESC) rather than one Claude finished.
   *
   * Cancel kills the child mid-stream, so NO `result` event ever arrives and
   * the pane would keep an active turn forever — the exact "Answering…"
   * spinner hang QAPert fixed for the ACP path. The partial text already
   * streamed is KEPT: the agent really did say it, and dropping it would make
   * ESC look like it erased work. We only add the missing turn boundary.
   *
   * Idempotent: a late `result` arriving after this simply settles again with
   * the same session, which the store treats as a no-op.
   */
  cancelTurn(): AcpSessionUpdate[] {
    this.sawTextDelta = false;
    this.streamedBlocks.clear();
    return [
      {
        sessionUpdate: 'turn_complete',
        sessionId: this.sessionId,
        stopReason: 'cancelled',
      },
    ];
  }

  private mapResult(event: ClaudeStreamJsonEvent): AcpSessionUpdate[] {
    // Turn boundary. `stop_reason` is the model's reason; `subtype`/`is_error`
    // report transport success. An errored result must surface as an error so
    // the pane's active turn settles instead of spinning forever.
    this.sawTextDelta = false;
    this.streamedBlocks.clear();

    if (event.is_error === true || event.subtype === 'error') {
      const message =
        typeof event.result === 'string' && event.result
          ? event.result
          : `Claude turn failed (${String(event.subtype ?? 'error')})`;
      return [
        { sessionUpdate: 'error', sessionId: this.sessionId, error: message },
        {
          sessionUpdate: 'turn_complete',
          sessionId: this.sessionId,
          stopReason: String(event.stop_reason ?? 'error'),
        },
      ];
    }

    return [
      {
        sessionUpdate: 'turn_complete',
        sessionId: this.sessionId,
        stopReason: String(event.stop_reason ?? 'end_turn'),
      },
    ];
  }
}

/**
 * Incremental NDJSON line splitter for the child's stdout.
 *
 * Chunks arrive on arbitrary boundaries, so a naive `split('\n')` per chunk
 * corrupts any event straddling two reads — the exact failure that makes a
 * structured transport look flaky under load. Holds the partial tail.
 */
export class NdjsonSplitter {
  private buffer = '';

  push(chunk: string): ClaudeStreamJsonEvent[] {
    this.buffer += chunk;
    const events: ClaudeStreamJsonEvent[] = [];
    let newline = this.buffer.indexOf('\n');

    while (newline !== -1) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (line) {
        try {
          events.push(JSON.parse(line) as ClaudeStreamJsonEvent);
        } catch {
          // A non-JSON line means the child wrote something unstructured to
          // stdout. Dropping it is correct: it is not a turn event, and
          // throwing here would kill a live session over log noise.
        }
      }
      newline = this.buffer.indexOf('\n');
    }
    return events;
  }
}
