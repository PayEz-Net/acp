import { useCallback, useMemo, useRef } from 'react';

interface HistoryBucket {
  entries: string[];
}

const buckets = new Map<string, HistoryBucket>();
const MAX_HISTORY = 50;

function getBucket(key: string): HistoryBucket {
  let bucket = buckets.get(key);
  if (!bucket) {
    bucket = { entries: [] };
    buckets.set(key, bucket);
  }
  return bucket;
}

export interface InputHistory {
  /** Cycle the input value through history. Returns the new value, or null if no history. */
  cycle(direction: 'up' | 'down', currentValue: string): string | null;
  /** Persist a sent input into history. */
  commit(text: string): void;
}

/**
 * Per-agent/per-session in-memory input history.
 *
 * Up/Down arrows recall previously-sent inputs. The current draft is preserved
 * while cycling and restored when moving below the newest history entry.
 */
export function useInputHistory(agent: string, sessionId?: string): InputHistory {
  const key = useMemo(() => `${agent}:${sessionId ?? '_default'}`, [agent, sessionId]);
  const indexRef = useRef(-1);
  const draftRef = useRef('');

  const cycle = useCallback(
    (direction: 'up' | 'down', currentValue: string): string | null => {
      const bucket = getBucket(key);
      if (bucket.entries.length === 0) return null;

      if (direction === 'up') {
        if (indexRef.current === -1) {
          draftRef.current = currentValue;
        }
        indexRef.current = Math.min(indexRef.current + 1, bucket.entries.length - 1);
      } else {
        indexRef.current = Math.max(indexRef.current - 1, -1);
      }

      if (indexRef.current === -1) {
        return draftRef.current;
      }
      return bucket.entries[bucket.entries.length - 1 - indexRef.current];
    },
    [key],
  );

  const commit = useCallback(
    (text: string): void => {
      const trimmed = text.trim();
      if (!trimmed) return;
      const bucket = getBucket(key);
      // Avoid duplicate consecutive entries.
      if (bucket.entries[bucket.entries.length - 1] !== trimmed) {
        bucket.entries.push(trimmed);
        if (bucket.entries.length > MAX_HISTORY) {
          bucket.entries.shift();
        }
      }
      indexRef.current = -1;
      draftRef.current = '';
    },
    [key],
  );

  return useMemo(() => ({ cycle, commit }), [cycle, commit]);
}
