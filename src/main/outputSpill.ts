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
 *  - Draining CLASSIFIES each failure (140734/184947 — this is not optional:
 *    without a cause you cannot tell the two cases below apart, and picking
 *    either blanket policy is wrong for the other case):
 *      RETRYABLE (backend-wide — network, 5xx, no bearer yet): behaves EXACTLY
 *        as before this card — stop the whole tick, no counting, never
 *        dead-lettered. "Always continue" here would cost one request per
 *        queued entry per tick against a backend that is already down, which
 *        is the exact self-inflicted flood the original stop-on-failure
 *        existed to prevent.
 *      TERMINAL (this entry specifically — rejected, malformed, dead
 *        credential): skip it and keep draining the rest of THIS tick,
 *        counting attempts, and dead-letter (move to `<dir>/dead-letter/`,
 *        never delete) once `maxDrainAttempts` is exceeded. "Always break"
 *        here is 140734 itself: one entry that can NEVER succeed blocked
 *        every entry behind it for 45+ hours while delivery to the backend
 *        was working the entire time.
 *    The caller supplies the classifier (its own isRetryable, already used
 *    for in-memory retry); the default classifies everything as retryable,
 *    which is the historical (pre-140734-fix) behavior, so a caller that
 *    hasn't wired classification yet gets the old, safe-but-blocking policy
 *    rather than a silently different one.
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
  /** Why this payload exhausted its in-memory retries (184947). Previously the
   *  caller HAD this at the spill site and threw it away — the console.warn
   *  that named it is not persisted anywhere, so it was unrecoverable the
   *  moment the process that logged it moved on. Optional: entries already on
   *  disk before this field existed, and any caller with no diagnosis, still
   *  parse cleanly. */
  cause?: string;
  /** In-memory retry attempts made before spilling (184947), same rationale. */
  attempts?: number;
  /** Separate DRAIN ticks this entry has failed on since being spilled
   *  (140734) — distinct from `attempts` above, which counts in-memory
   *  retries BEFORE the entry ever reached disk. Persisted so the count
   *  survives a process restart; absent/0 means never attempted since spill. */
  drainAttempts?: number;
}

/** Bounded so a long outage cannot fill the disk. */
const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;

/** Separate drain ticks an entry must fail on before it is dead-lettered
 *  (140734). At the 15s drainIntervalMs this module is configured with
 *  elsewhere, 10 is ~2.5 minutes — long enough that an ordinary reconnect
 *  clears it via the normal stop-and-retry path first, short enough that a
 *  genuinely poisoned entry no longer blocks the queue for days. */
const DEFAULT_MAX_DRAIN_ATTEMPTS = 10;

const DEAD_LETTER_DIRNAME = 'dead-letter';

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
  cause?: string,
  attempts?: number,
): Promise<{ result: 'spilled' | 'evicted' | 'unavailable'; evictedBytes: number }> {
  const dir = spillDir;
  if (!dir) return { result: 'unavailable', evictedBytes: 0 };

  // JSON.stringify drops undefined-valued keys, so a caller with no
  // diagnosis produces the exact same on-disk shape as before this field
  // existed (184947).
  const entry: SpilledEntry<P> = { payload, idempotencyKey, spilledAt: now, cause, attempts };
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

/** Move a poison entry aside instead of deleting it (140734) — it survived
 *  every in-memory retry AND the entire drain-attempt budget, so whatever it
 *  contains is exactly the kind of thing someone will want to inspect. Falls
 *  back to delete only if the move itself fails, so a filesystem hiccup can
 *  never resurrect 140734 by leaving the poisoned head in the live queue. */
async function deadLetterEntry(dir: string, filename: string): Promise<void> {
  const deadDir = path.join(dir, DEAD_LETTER_DIRNAME);
  const from = path.join(dir, filename);
  try {
    await fs.mkdir(deadDir, { recursive: true });
    await fs.rename(from, path.join(deadDir, filename));
  } catch {
    await fs.unlink(from).catch(() => {});
  }
}

/** How a drain failure should be handled — see the module header. */
export type DrainFailureClass = 'retryable' | 'terminal';

export interface DrainOptions {
  /** Cap on entries examined this tick. */
  limit?: number;
  /** Separate drain ticks a 'terminal'-classified entry must fail on before
   *  it is dead-lettered. Irrelevant to 'retryable' failures, which are
   *  never dead-lettered regardless of how many ticks they span. */
  maxDrainAttempts?: number;
  /** Classify a thrown failure. Defaults to always 'retryable' — the
   *  historical stop-on-first-failure behavior — so a caller that has not
   *  wired a classifier gets the old, blocking-but-safe policy rather than a
   *  silently different one. Callers should pass their own retryability
   *  check (ptyOutputReporter.ts already has one for exactly this). */
  classify?: (err: unknown) => DrainFailureClass;
}

/**
 * Attempt to re-send spilled entries oldest-first.
 *
 * `post` must throw on failure. See the module header for the classify-
 * driven policy split (140734/184947): a 'retryable' failure stops the whole
 * tick with no counting, exactly as before this card; a 'terminal' one is
 * skipped, counted, and eventually dead-lettered instead of blocking
 * everything behind it.
 */
export async function drainSpill<P>(
  post: (payload: P, idempotencyKey: string) => Promise<void>,
  opts: DrainOptions = {},
): Promise<{ sent: number; remaining: number; deadLettered: number; stoppedOnFailure: boolean }> {
  const dir = spillDir;
  if (!dir) return { sent: 0, remaining: 0, deadLettered: 0, stoppedOnFailure: false };

  const limit = opts.limit ?? 50;
  const maxDrainAttempts = opts.maxDrainAttempts ?? DEFAULT_MAX_DRAIN_ATTEMPTS;
  const classify = opts.classify ?? (() => 'retryable' as const);

  const files = await entryFiles(dir);
  let sent = 0;
  let deadLettered = 0;
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
    } catch (err) {
      if (classify(err) === 'retryable') {
        // Backend-wide, not this entry's fault: stop here, exactly as this
        // module always has. No counting, never dead-lettered — only
        // spillOutput's own overflow eviction bounds how long this can sit.
        stoppedOnFailure = true;
        break;
      }

      // 'terminal': this entry itself cannot succeed. Skip it (keep draining
      // whatever is behind it THIS tick — that is 140734's fix) and count
      // toward dead-lettering rather than retrying it forever.
      const drainAttempts = (entry.drainAttempts ?? 0) + 1;
      if (drainAttempts > maxDrainAttempts) {
        await deadLetterEntry(dir, f);
        deadLettered++;
        continue;
      }
      await fs
        .writeFile(p, JSON.stringify({ ...entry, drainAttempts }), 'utf8')
        .catch(() => {});
      continue;
    }
  }

  const after = await entryFiles(dir);
  return { sent, remaining: after.length, deadLettered, stoppedOnFailure };
}

/** Queue depth and size, for status reporting. */
export async function spillStats(): Promise<{ entries: number; bytes: number }> {
  const dir = spillDir;
  if (!dir) return { entries: 0, bytes: 0 };
  const files = await entryFiles(dir);
  return { entries: files.length, bytes: await totalBytes(dir, files) };
}
