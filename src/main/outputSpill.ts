/**
 * On-disk spill queue for agent output that exhausted its in-memory retries.
 *
 * WHY THIS EXISTS. Before it, a payload that failed MAX_RETRIES was discarded
 * permanently. On 2026-07-29 a ~9 minute vibe-api outage destroyed ~2.26 MB of
 * agent output across five agents — content that existed, was recoverable, and
 * simply ceased to be. Retry-then-delete is the wrong policy for a record the
 * product treats as an audit trail: a backend blip should mean "the recording
 * paused", never "that work is gone".
 *
 * DESIGN NOTES
 *  - Spilling is the LAST step before a drop, not a replacement for retrying.
 *    In-memory retry still handles the common transient case; disk absorbs the
 *    sustained outage.
 *  - The queue is BOUNDED. An unbounded spill turns a backend outage into a
 *    disk-full outage, which is worse. On overflow the OLDEST entry is evicted
 *    and that eviction is reported — a silent cap would read as "nothing was
 *    lost", which is the exact failure mode this module exists to end.
 *  - Draining stops at the FIRST failure. If the backend is still down, walking
 *    the rest of the queue just burns requests and re-times-out; the next tick
 *    retries from the same point.
 *  - Entries carry their original idempotency key, so a payload that actually
 *    landed before the client gave up cannot be double-stored on drain.
 */
import { promises as fs } from 'fs';
import * as path from 'path';

export interface SpilledEntry<P = unknown> {
  payload: P;
  idempotencyKey: string;
  /** When the payload was first spilled (epoch ms). Ordering + diagnostics. */
  spilledAt: number;
}

/** Bounded so a long outage cannot fill the disk. */
const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;

let spillDir: string | null = null;
let maxBytes = DEFAULT_MAX_BYTES;
let seq = 0;

/**
 * Point the queue at a directory. Call once during main-process startup with
 * `app.getPath('userData')`. Kept as explicit configuration rather than an
 * internal `require('electron')` so the queue is testable off a temp dir.
 */
export function configureSpill(dir: string, maxTotalBytes = DEFAULT_MAX_BYTES): void {
  spillDir = dir;
  maxBytes = maxTotalBytes;
}

export function isSpillConfigured(): boolean {
  return spillDir !== null;
}

/** Reset module state. Tests only. */
export function resetSpillForTests(): void {
  spillDir = null;
  maxBytes = DEFAULT_MAX_BYTES;
  seq = 0;
}

async function entryFiles(dir: string): Promise<string[]> {
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return [];
  }
  // Filenames are `<zero-padded epoch>-<zero-padded seq>.json`, so lexical sort
  // IS chronological. Sorting by mtime would be wrong: several entries can land
  // in the same millisecond during a burst.
  return names.filter((n) => n.endsWith('.json')).sort();
}

async function totalBytes(dir: string, files: string[]): Promise<number> {
  let sum = 0;
  for (const f of files) {
    try {
      sum += (await fs.stat(path.join(dir, f))).size;
    } catch {
      /* raced with a drain; ignore */
    }
  }
  return sum;
}

/**
 * Persist a payload that exhausted its retries.
 *
 * Returns what happened so the caller can report it honestly:
 *  - `spilled`   — durably queued, not lost
 *  - `evicted`   — queued, but an older entry was dropped to make room
 *  - `unavailable` — the queue could not accept it (not configured, or I/O
 *    failed). The caller must still count this as a real drop.
 */
export async function spillOutput<P>(
  payload: P,
  idempotencyKey: string,
  now: number = Date.now(),
): Promise<{ result: 'spilled' | 'evicted' | 'unavailable'; evictedBytes: number }> {
  const dir = spillDir;
  if (!dir) return { result: 'unavailable', evictedBytes: 0 };

  const entry: SpilledEntry<P> = { payload, idempotencyKey, spilledAt: now };
  const body = JSON.stringify(entry);

  try {
    await fs.mkdir(dir, { recursive: true });

    let evictedBytes = 0;
    let files = await entryFiles(dir);
    let used = await totalBytes(dir, files);

    // Evict oldest-first until the new entry fits.
    while (files.length > 0 && used + Buffer.byteLength(body) > maxBytes) {
      const victim = files.shift()!;
      const p = path.join(dir, victim);
      try {
        const size = (await fs.stat(p)).size;
        await fs.unlink(p);
        used -= size;
        evictedBytes += size;
      } catch {
        break; // cannot reclaim; stop rather than spin
      }
    }

    const name = `${String(now).padStart(15, '0')}-${String(seq++).padStart(6, '0')}.json`;
    await fs.writeFile(path.join(dir, name), body, 'utf8');
    return { result: evictedBytes > 0 ? 'evicted' : 'spilled', evictedBytes };
  } catch {
    return { result: 'unavailable', evictedBytes: 0 };
  }
}

/**
 * Attempt to re-send spilled entries oldest-first.
 *
 * `post` must throw on failure. Stops at the first failure — a still-down
 * backend should not cost one request per queued entry.
 */
export async function drainSpill<P>(
  post: (payload: P, idempotencyKey: string) => Promise<void>,
  limit = 50,
): Promise<{ sent: number; remaining: number; stoppedOnFailure: boolean }> {
  const dir = spillDir;
  if (!dir) return { sent: 0, remaining: 0, stoppedOnFailure: false };

  const files = await entryFiles(dir);
  let sent = 0;
  let stoppedOnFailure = false;

  for (const f of files.slice(0, limit)) {
    const p = path.join(dir, f);
    let entry: SpilledEntry<P>;
    try {
      entry = JSON.parse(await fs.readFile(p, 'utf8')) as SpilledEntry<P>;
    } catch {
      // Unreadable or truncated (e.g. killed mid-write). It can never be sent,
      // so remove it rather than blocking the queue head forever.
      await fs.unlink(p).catch(() => {});
      continue;
    }
    try {
      await post(entry.payload, entry.idempotencyKey);
      await fs.unlink(p).catch(() => {});
      sent++;
    } catch {
      stoppedOnFailure = true;
      break;
    }
  }

  const after = await entryFiles(dir);
  return { sent, remaining: after.length, stoppedOnFailure };
}

/** Queue depth and size, for status reporting. */
export async function spillStats(): Promise<{ entries: number; bytes: number }> {
  const dir = spillDir;
  if (!dir) return { entries: 0, bytes: 0 };
  const files = await entryFiles(dir);
  return { entries: files.length, bytes: await totalBytes(dir, files) };
}
