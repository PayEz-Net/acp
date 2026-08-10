/**
 * Agent stream bridge — ACP feed.
 *
 * Turns `AcpSessionUpdate` events into records on the SAME transport the PTY
 * feed already uses (`reportPtyOutput`), so both runtimes land in one place:
 * vibe-api `/v1/agent-output` → 93 `vibe_cache.agent_output_events`.
 *
 * WHY THIS EXISTS
 * ---------------
 * The capture was empty for twelve days and nothing said so. Measured
 * 2026-08-10: 0 rows in every cache home, newest row anywhere 2026-07-29. Not a
 * delivery failure — nothing was feeding it. The only writer reports PTY output,
 * and ACP agents never touch a PTY (`kimi.supportsAcp === true`), so the capture
 * silently went to zero the day the team moved to Kimi.
 *
 * WHY IT REUSES THE PTY TRANSPORT INSTEAD OF POSTING ITSELF
 * ---------------------------------------------------------
 * `ptyOutputReporter` already owns batching, spill-to-disk, dead-letter, retry
 * and drop accounting — the parts that are hard and already paid for. A second
 * POST path would be a second thing to keep correct, and duplicated transports
 * drift. One writer, one destination. This module only NORMALISES.
 *
 * ENCODING: WHY JSONL RATHER THAN PROSE
 * -------------------------------------
 * The transport carries a string, because it was built for terminal bytes. The
 * ACP feed has real structure (turn boundaries, tool calls, stop reasons) and
 * flattening that to prose would throw away the exact thing that makes this feed
 * better than the one it supplements — a consumer would have to re-derive turns
 * by regex, which is what made the PTY stream nearly useless for turn analysis.
 * So ACP records are emitted as JSONL: one JSON object per line.
 *
 * Consumers tell the two apart by `provider`: `kimi` → JSONL records,
 * `claude`/`codex` → raw terminal bytes. That asymmetry is a known wart and is
 * carded in the TO-BE doc (a real `kind` column is the right fix). It is NOT
 * papered over here, because a bridge that guesses a schema is worse than one
 * that states its shape.
 */

import type { AcpSessionUpdate } from '../shared/acpTypes';
import { reportPtyOutput } from './ptyOutputReporter';

/** Record kinds. Deliberately smaller than the ACP vocabulary — see `toRecord`. */
export type StreamRecordKind =
  | 'turn_start'
  | 'turn_end'
  | 'text'
  | 'thought'
  | 'tool'
  | 'tool_result'
  | 'wait'
  | 'permission'
  | 'error';

export interface StreamRecord {
  kind: StreamRecordKind;
  seq: number;
  text?: string;
  /** Only what the kind actually carries; never a fixed shape padded with nulls. */
  meta?: Record<string, unknown>;
}

/**
 * Monotonic per terminal. Sequence exists because the transport BATCHES and
 * RETRIES: arrival order at the far end is not emission order, and a consumer
 * reconstructing a turn needs the emission order. Without this, a retried batch
 * silently reorders a conversation and the replay reads as nonsense.
 */
const seqByTerminal = new Map<string, number>();

function nextSeq(terminalId: string): number {
  const n = (seqByTerminal.get(terminalId) ?? 0) + 1;
  seqByTerminal.set(terminalId, n);
  return n;
}

/** Drop counters for records this module chose not to forward. */
const skippedByTerminal = new Map<string, number>();

/** Free per-terminal state. Call on ACP teardown or the maps grow forever. */
export function resetStreamState(terminalId: string): void {
  seqByTerminal.delete(terminalId);
  skippedByTerminal.delete(terminalId);
}

/** How many updates were deliberately not captured, for the drop audit. */
export function getSkippedCount(terminalId: string): number {
  return skippedByTerminal.get(terminalId) ?? 0;
}

/** Text out of an ACP content block, which may be a string or a typed block. */
function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (content && typeof content === 'object') {
    const c = content as Record<string, unknown>;
    if (typeof c.text === 'string') return c.text;
    // A non-text block (image, resource). Record its presence rather than
    // dropping the turn's content silently — "an image happened here" is
    // information; a gap is not.
    if (typeof c.type === 'string') return `[${c.type}]`;
  }
  return '';
}

/**
 * Map one ACP update to a record, or null to skip it.
 *
 * SKIPS ARE DELIBERATE AND ENUMERATED. Control-plane chatter (queue depth,
 * command lists, spawn info) carries no work signal, and capturing it would bury
 * the signal in noise. Everything skipped is counted, so "we captured less than
 * happened" is visible rather than assumed.
 */
export function toRecord(update: AcpSessionUpdate, seq: number): StreamRecord | null {
  const u = update as AcpSessionUpdate & Record<string, any>;
  switch (u.sessionUpdate) {
    case 'turn_started':
      return { kind: 'turn_start', seq };

    case 'turn_complete':
      // stopReason is what separates a turn that finished from one that was
      // cancelled or hit a limit. A turn count without it over-reports work.
      return { kind: 'turn_end', seq, meta: { stopReason: u.stopReason } };

    case 'agent_message_chunk': {
      const text = contentText(u.content);
      return text ? { kind: 'text', seq, text } : null;
    }

    case 'agent_thought_chunk': {
      const text = contentText(u.content);
      // Kept, but tagged: thinking is where a stuck agent is visible, and it is
      // also the highest-volume kind. Tagging lets a consumer exclude it in one
      // predicate instead of guessing from content.
      return text ? { kind: 'thought', seq, text } : null;
    }

    case 'tool_call':
      return {
        kind: 'tool',
        seq,
        text: u.toolCall?.title ?? '',
        meta: { toolCallId: u.toolCall?.toolCallId, status: u.toolCall?.status },
      };

    case 'tool_call_update':
      return {
        kind: 'tool_result',
        seq,
        // contentText is the tool's RESULT. Recording only the title would
        // capture that a tool ran and lose what it returned — half a record.
        text: u.toolCall?.contentText ?? u.toolCall?.title ?? '',
        meta: { toolCallId: u.toolCall?.toolCallId, status: u.toolCall?.status },
      };

    case 'wait_state':
      // "The agent is blocked" — the single most useful state to catch early,
      // and one the PTY feed could never express.
      return { kind: 'wait', seq, meta: { waitState: u.waitState } };

    case 'permission_request':
      return {
        kind: 'permission',
        seq,
        text: u.toolCall?.title ?? '',
        meta: { requestId: u.requestId },
      };

    case 'error':
      // A capture that drops failures reports a healthier system than exists.
      return { kind: 'error', seq, text: String(u.error ?? '') };

    case 'stderr':
      return u.text ? { kind: 'error', seq, text: String(u.text) } : null;

    default:
      // initialized / spawn_info / available_commands_update / prompt_queued /
      // prompt_dequeued / queue_cleared — control plane, no work signal.
      return null;
  }
}

/**
 * Forward one ACP event to the capture.
 *
 * NEVER THROWS. A telemetry failure must not break a turn or a spawn — an agent
 * that cannot work because the observability path failed is a catastrophic trade
 * for an observability feature. Failures log and drop that single record.
 */
export function bridgeAcpEvent(
  agentName: string,
  terminalId: string,
  provider: string,
  update: AcpSessionUpdate,
): void {
  try {
    const seq = nextSeq(terminalId);
    const record = toRecord(update, seq);
    if (!record) {
      // Roll back the sequence: skipped updates must not leave holes, or a
      // consumer cannot distinguish "not captured" from "lost in transit" —
      // and losing-in-transit is the thing worth alarming on.
      seqByTerminal.set(terminalId, seq - 1);
      skippedByTerminal.set(terminalId, (skippedByTerminal.get(terminalId) ?? 0) + 1);
      return;
    }
    reportPtyOutput(agentName, terminalId, JSON.stringify(record) + '\n', provider);
  } catch (err) {
    console.warn(
      `[streamBridge] dropped one record for ${agentName}:`,
      err instanceof Error ? err.message : String(err),
    );
  }
}
