/**
 * BRIDGE 1 (kanban 117423): append-only, durable store for Claude stream-json
 * events.
 *
 * One JSONL file per agent per Claude session:
 *   <baseDir>/<agentName>/<sessionId>.jsonl
 * Events that arrive before `system/init` yields a session id land in
 * `pre-init.jsonl` — they are init/handshake traffic and stay queryable.
 *
 * Writes are SYNCHRONOUS and per-event on purpose: the card's contract is
 * "persist each event as it arrives" and "the store survives the pane being
 * killed". A buffered/async writer would lose the tail of exactly the crash
 * sessions this store exists to diagnose. Event volume is ~KB per turn
 * (measured 2026-07-29: ~2.4 KB steady-state), so sync appends are cheap.
 *
 * Query side is a plain read of the same files — a consumer one minute behind
 * the writer sees everything, because nothing is ever held in memory.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { ClaudeStreamJsonEvent } from './claudeStreamJson';

/** One persisted event envelope. `ts` is the bridge's receive time (ISO). */
export interface StoredBridgeEvent {
  ts: string;
  event: ClaudeStreamJsonEvent;
}

export interface BridgeEventQuery {
  /** Only events received at/after this time (ISO string or Date). */
  since?: string | Date;
  /** Only these top-level event `type` values (e.g. 'assistant', 'result'). */
  types?: string[];
  /** Cap on returned events, most-recent-last after sorting. */
  limit?: number;
}

const PRE_INIT_FILE = 'pre-init.jsonl';

/** Filesystem-safe agent name: keep word chars, dash and dot only. */
function safeAgentName(agentName: string): string {
  const cleaned = agentName.replace(/[^\w.-]/g, '_');
  if (!cleaned || cleaned === '.' || cleaned === '..') {
    throw new Error(`agent name '${agentName}' has no filesystem-safe characters`);
  }
  return cleaned;
}

/** Filesystem-safe session id; uuids pass through untouched. */
function safeSessionId(sessionId: string): string {
  const cleaned = sessionId.replace(/[^\w.-]/g, '_');
  if (!cleaned || cleaned === '.' || cleaned === '..') {
    throw new Error(`session id has no filesystem-safe characters`);
  }
  return cleaned;
}

function sessionFile(baseDir: string, agentName: string, sessionId: string | null): string {
  const file = sessionId ? `${safeSessionId(sessionId)}.jsonl` : PRE_INIT_FILE;
  return path.join(baseDir, safeAgentName(agentName), file);
}

/**
 * Append one event as it arrives. Creates the agent directory lazily.
 * Best-effort by contract: a store failure must never kill a live bridge,
 * so this throws ONLY on programmer error (unsafe names); IO errors are
 * reported via onError and dropped.
 */
export function appendBridgeEvent(
  baseDir: string,
  agentName: string,
  sessionId: string | null,
  event: ClaudeStreamJsonEvent,
  ts: Date = new Date(),
  onError: (err: unknown) => void = (err) => console.warn('[BridgeEventStore] append failed:', err),
): void {
  const file = sessionFile(baseDir, agentName, sessionId);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const line: StoredBridgeEvent = { ts: ts.toISOString(), event };
    fs.appendFileSync(file, `${JSON.stringify(line)}\n`, { encoding: 'utf8' });
  } catch (err) {
    onError(err);
  }
}

/**
 * Read back an agent's stored events across all sessions, oldest first.
 * Corrupt lines (a crash mid-append can leave a torn tail) are skipped, not
 * fatal — the rest of the file is still evidence.
 */
export function queryBridgeEvents(
  baseDir: string,
  agentName: string,
  query: BridgeEventQuery = {},
): StoredBridgeEvent[] {
  const dir = path.join(baseDir, safeAgentName(agentName));
  let files: string[];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
  } catch {
    return []; // no store yet = no events, not an error
  }

  const sinceMs = query.since === undefined ? null : new Date(query.since).getTime();
  const types = query.types ? new Set(query.types) : null;
  const out: StoredBridgeEvent[] = [];

  for (const f of files) {
    let text: string;
    try {
      text = fs.readFileSync(path.join(dir, f), 'utf8');
    } catch {
      continue; // raced a rotation/lock; other files still read
    }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      let parsed: StoredBridgeEvent;
      try {
        parsed = JSON.parse(line) as StoredBridgeEvent;
      } catch {
        continue; // torn tail from a kill mid-append
      }
      if (sinceMs !== null && new Date(parsed.ts).getTime() < sinceMs) continue;
      if (types && !types.has(parsed.event?.type)) continue;
      out.push(parsed);
    }
  }

  out.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
  if (query.limit !== undefined && out.length > query.limit) {
    return out.slice(out.length - query.limit);
  }
  return out;
}
