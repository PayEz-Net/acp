/**
 * In-memory soft cache for team sync results.
 *
 * Keyed by IDP user_id so a user-switch (login/logout/login-as-other) does
 * not return another user's team. 60s TTL by default; force_refresh=true on
 * the route bypasses the TTL check entirely.
 *
 * On cloud-unreachable, the route falls through to the cached entry even
 * past TTL — the entry is still present until explicitly cleared, and the
 * route signals staleness via `source: 'cache'` + a warning string.
 */

import type { MappedAgent } from './mapper.js';

export interface TeamCacheEntry {
  agents: MappedAgent[];
  fetchedAt: string; // ISO 8601
}

const TTL_MS = 60_000;

const store = new Map<string, TeamCacheEntry & { fetchedAtMs: number }>();

export function getFresh(userId: string): TeamCacheEntry | null {
  const entry = store.get(userId);
  if (!entry) return null;
  if (Date.now() - entry.fetchedAtMs > TTL_MS) return null;
  return { agents: entry.agents, fetchedAt: entry.fetchedAt };
}

/**
 * Returns whatever is in the cache for this user — even if it's past TTL.
 * Used as the cloud-unreachable fallback.
 */
export function getStale(userId: string): TeamCacheEntry | null {
  const entry = store.get(userId);
  if (!entry) return null;
  return { agents: entry.agents, fetchedAt: entry.fetchedAt };
}

export function set(userId: string, agents: MappedAgent[]): TeamCacheEntry {
  const now = Date.now();
  const entry = {
    agents,
    fetchedAt: new Date(now).toISOString(),
    fetchedAtMs: now,
  };
  store.set(userId, entry);
  return { agents: entry.agents, fetchedAt: entry.fetchedAt };
}

export function clear(userId?: string): void {
  if (userId) {
    store.delete(userId);
  } else {
    store.clear();
  }
}
