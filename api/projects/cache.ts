/**
 * DRAFT — Wave 2 (gated on QAPert AC-pass).
 * Target path: acp-api/api/projects/cache.ts
 *
 * REVISED 2026-05-08 post-QAPert: pointer enum renamed to
 * `active_project_state` and now `stored | unset | empty` (per spec §5.4).
 *
 * Two-slot in-memory cache for the project sync surface:
 *   - `list`   — full project list per developer
 *   - `active` — active-project pointer per developer
 *
 * Both keyed by IDP user_id, both 60s TTL. Mirrors team/cache.ts:
 *   getFresh()  honors TTL — returns null past 60s.
 *   getStale()  ignores TTL — used as the cloud-unreachable fallback.
 *
 * Cache invalidation on writeback (POST→PUT bridge) clears `active` for
 * the user; `list` is left intact since switching active doesn't change
 * membership.
 */

import type { MappedProject, ActiveProjectState } from './mapper.js';

const TTL_MS = 60_000;

export interface ProjectListEntry {
  projects: MappedProject[];
  fetchedAt: string;
}

export interface ActiveProjectEntry {
  active_project_id: number | null;
  project: MappedProject | null;
  active_project_state: ActiveProjectState;
  fetchedAt: string;
}

const listStore = new Map<string, ProjectListEntry & { fetchedAtMs: number }>();
const activeStore = new Map<string, ActiveProjectEntry & { fetchedAtMs: number }>();

function freshGet<T extends { fetchedAtMs: number }>(
  store: Map<string, T>,
  userId: string,
): T | null {
  const entry = store.get(userId);
  if (!entry) return null;
  if (Date.now() - entry.fetchedAtMs > TTL_MS) return null;
  return entry;
}

function staleGet<T>(store: Map<string, T>, userId: string): T | null {
  return store.get(userId) ?? null;
}

export const list = {
  getFresh(userId: string): ProjectListEntry | null {
    const entry = freshGet(listStore, userId);
    if (!entry) return null;
    return { projects: entry.projects, fetchedAt: entry.fetchedAt };
  },
  getStale(userId: string): ProjectListEntry | null {
    const entry = staleGet(listStore, userId);
    if (!entry) return null;
    return { projects: entry.projects, fetchedAt: entry.fetchedAt };
  },
  set(userId: string, projects: MappedProject[]): ProjectListEntry {
    const now = Date.now();
    const entry = {
      projects,
      fetchedAt: new Date(now).toISOString(),
      fetchedAtMs: now,
    };
    listStore.set(userId, entry);
    return { projects: entry.projects, fetchedAt: entry.fetchedAt };
  },
  clear(userId?: string): void {
    if (userId) listStore.delete(userId);
    else listStore.clear();
  },
};

export const active = {
  getFresh(userId: string): ActiveProjectEntry | null {
    const entry = freshGet(activeStore, userId);
    if (!entry) return null;
    return {
      active_project_id: entry.active_project_id,
      project: entry.project,
      active_project_state: entry.active_project_state,
      fetchedAt: entry.fetchedAt,
    };
  },
  getStale(userId: string): ActiveProjectEntry | null {
    const entry = staleGet(activeStore, userId);
    if (!entry) return null;
    return {
      active_project_id: entry.active_project_id,
      project: entry.project,
      active_project_state: entry.active_project_state,
      fetchedAt: entry.fetchedAt,
    };
  },
  set(
    userId: string,
    payload: {
      active_project_id: number | null;
      project: MappedProject | null;
      active_project_state: ActiveProjectState;
    },
  ): ActiveProjectEntry {
    const now = Date.now();
    const entry = {
      ...payload,
      fetchedAt: new Date(now).toISOString(),
      fetchedAtMs: now,
    };
    activeStore.set(userId, entry);
    return {
      active_project_id: entry.active_project_id,
      project: entry.project,
      active_project_state: entry.active_project_state,
      fetchedAt: entry.fetchedAt,
    };
  },
  clear(userId?: string): void {
    if (userId) activeStore.delete(userId);
    else activeStore.clear();
  },
};
