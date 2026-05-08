/**
 * Wave 2 + post-rename: in-memory soft cache for project sync surface.
 *
 * Two-slot store keyed by IDP user_id, both 60s TTL:
 *   - `list`    — full project list per developer
 *   - `current` — current-project pointer per developer
 *
 *   getFresh()  honors TTL — returns null past 60s.
 *   getStale()  ignores TTL — used as the cloud-unreachable fallback.
 *
 * Cache invalidation on writeback (POST→PUT bridge) clears `current` for
 * the user; `list` is left intact since switching focus doesn't change
 * membership.
 */

import type { MappedProject, CurrentProjectState } from './mapper.js';

const TTL_MS = 60_000;

export interface ProjectListEntry {
  projects: MappedProject[];
  fetchedAt: string;
}

export interface CurrentProjectEntry {
  current_project_id: number | null;
  project: MappedProject | null;
  current_project_state: CurrentProjectState;
  fetchedAt: string;
}

const listStore = new Map<string, ProjectListEntry & { fetchedAtMs: number }>();
const currentStore = new Map<string, CurrentProjectEntry & { fetchedAtMs: number }>();

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

export const current = {
  getFresh(userId: string): CurrentProjectEntry | null {
    const entry = freshGet(currentStore, userId);
    if (!entry) return null;
    return {
      current_project_id: entry.current_project_id,
      project: entry.project,
      current_project_state: entry.current_project_state,
      fetchedAt: entry.fetchedAt,
    };
  },
  getStale(userId: string): CurrentProjectEntry | null {
    const entry = staleGet(currentStore, userId);
    if (!entry) return null;
    return {
      current_project_id: entry.current_project_id,
      project: entry.project,
      current_project_state: entry.current_project_state,
      fetchedAt: entry.fetchedAt,
    };
  },
  set(
    userId: string,
    payload: {
      current_project_id: number | null;
      project: MappedProject | null;
      current_project_state: CurrentProjectState;
    },
  ): CurrentProjectEntry {
    const now = Date.now();
    const entry = {
      ...payload,
      fetchedAt: new Date(now).toISOString(),
      fetchedAtMs: now,
    };
    currentStore.set(userId, entry);
    return {
      current_project_id: entry.current_project_id,
      project: entry.project,
      current_project_state: entry.current_project_state,
      fetchedAt: entry.fetchedAt,
    };
  },
  clear(userId?: string): void {
    if (userId) currentStore.delete(userId);
    else currentStore.clear();
  },
};
