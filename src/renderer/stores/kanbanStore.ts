import { create } from 'zustand';
import { KanbanTask, KanbanLane, KanbanPriority } from '@shared/types';
import { useAppStore } from './appStore';
import { useNotificationStore } from './notificationStore';
import { apiRequest } from './api-helpers';

// Map API status values to kanban lane names
function statusToLane(status: string): KanbanLane {
  switch (status) {
    case 'todo': case 'open': case 'new': return 'backlog';
    case 'in_progress': case 'active': case 'working': return 'in_progress';
    case 'review': case 'testing': case 'qa': return 'review';
    case 'done': case 'completed': case 'closed': case 'resolved': return 'done';
    default: return 'backlog';
  }
}

// Map kanban lane names back to acp-api status values (the write boundary).
// 'ready' has no acp-api status; new work starts in backlog.
function laneToStatus(lane: KanbanLane): string {
  switch (lane) {
    case 'in_progress': return 'in_progress';
    case 'review': return 'review';
    case 'done': return 'done';
    case 'ready': case 'backlog': default: return 'backlog';
  }
}

// Helper to make authenticated requests to acp-api kanban endpoints
async function kanbanRequest(endpoint: string, options: { method?: string; body?: unknown } = {}): Promise<Response> {
  return apiRequest('/v1/kanban', endpoint, options);
}

interface KanbanFilters {
  assignee?: string;
  priority?: KanbanPriority;
  milestone?: string;
}

// Human-readable lane labels — used for the "Restored to {column}" feedback so a
// restore names where the card lands (#153-A, Aurum 2747 closes-the-loop rule).
const LANE_LABELS: Record<KanbanLane, string> = {
  backlog: 'Backlog',
  ready: 'Ready',
  in_progress: 'In Progress',
  review: 'Review',
  done: 'Done',
};

interface KanbanStore {
  tasks: KanbanTask[];
  archivedTasks: KanbanTask[];
  selectedTask: KanbanTask | null;
  isCreatingTask: boolean;
  filters: KanbanFilters;
  loading: boolean;
  archivedLoading: boolean;
  error?: string;

  setSelectedTask: (task: KanbanTask | null) => void;
  setCreatingTask: (isCreating: boolean) => void;
  setFilters: (filters: Partial<KanbanFilters>) => void;

  fetchTasks: () => Promise<void>;
  fetchArchived: () => Promise<void>;
  createTask: (task: { title: string; description?: string; lane?: KanbanLane; priority?: KanbanPriority; assignedTo?: string }) => Promise<boolean>;
  moveTask: (taskId: number, newLane: KanbanLane) => Promise<boolean>;
  archiveTask: (taskId: number) => Promise<boolean>;
  unarchiveTask: (taskId: number) => Promise<boolean>;
  updateFromSse: (data: Record<string, unknown>) => void;
}

// Shared mapper: API rows (status/assignedTo) -> KanbanTask (lane). Dedup by id.
function mapTasks(rawTasks: Record<string, unknown>[]): KanbanTask[] {
  const mapped: KanbanTask[] = rawTasks.map((t) => ({
    ...t,
    lane: (t.lane as KanbanLane) || statusToLane((t.status as string) || ''),
    priority: (t.priority as string) || 'medium',
  })) as KanbanTask[];
  const seen = new Set<number>();
  return mapped.filter((t) => {
    if (seen.has(t.id)) return false;
    seen.add(t.id);
    return true;
  });
}

export const useKanbanStore = create<KanbanStore>((set, get) => ({
  tasks: [],
  archivedTasks: [],
  selectedTask: null,
  isCreatingTask: false,
  filters: {},
  loading: false,
  archivedLoading: false,

  setSelectedTask: (task) => set({ selectedTask: task, isCreatingTask: false }),
  setCreatingTask: (isCreating) => set({ isCreatingTask: isCreating, selectedTask: null }),
  setFilters: (filters) => set((state) => ({ filters: { ...state.filters, ...filters } })),

  fetchTasks: async () => {
    if (!useAppStore.getState().backendAvailable) return;
    set({ loading: true, error: undefined });
    try {
      const res = await kanbanRequest('/tasks');
      if (!res.ok) throw new Error(`${res.status}`);
      const data = await res.json();
      const rawTasks = data.data?.tasks || data.data || data.tasks || [];
      // Map API fields (status, assignedTo) to KanbanTask fields (lane, assigned_agent_id)
      set({ tasks: mapTasks(rawTasks), loading: false });
    } catch (err) {
      console.error('[Kanban] Failed to fetch tasks:', err);
      set({ loading: false, error: 'Failed to fetch tasks' });
    }
  },

  // #153-A: the recovery surface's data. Archived cards are fetched separately
  // (GET /tasks?archived=true) so the live board stays clean — archived items are
  // out-of-flow, never interleaved into the working columns (Aurum 2747). Each row
  // keeps its ORIGIN status -> lane, so the Archived view shows where a card returns
  // and Restore lands it in its OWN column (BE preserves status; no default).
  fetchArchived: async () => {
    if (!useAppStore.getState().backendAvailable) return;
    set({ archivedLoading: true });
    try {
      const res = await kanbanRequest('/tasks?archived=true');
      if (!res.ok) throw new Error(`${res.status}`);
      const data = await res.json();
      const rawTasks = data.data?.tasks || data.data || data.tasks || [];
      set({ archivedTasks: mapTasks(rawTasks), archivedLoading: false });
    } catch (err) {
      console.error('[Kanban] Failed to fetch archived tasks:', err);
      set({ archivedLoading: false });
    }
  },

  createTask: async (task) => {
    if (!useAppStore.getState().backendAvailable) return false;
    try {
      // Translate the desktop's lane-based model to the acp-api create contract
      // (status + assignedTo, camelCase). Posting raw lane/assigned_agent_id was
      // silently dropped by the API — assignment lost, priority defaulted.
      const body = {
        title: task.title,
        description: task.description,
        status: laneToStatus(task.lane || 'backlog'),
        priority: task.priority,
        assignedTo: task.assignedTo,
      };
      const res = await kanbanRequest('/tasks', { method: 'POST', body });
      if (!res.ok) throw new Error(`${res.status}`);
      await get().fetchTasks();
      set({ isCreatingTask: false });
      return true;
    } catch (err) {
      console.error('[Kanban] Failed to create task:', err);
      return false;
    }
  },

  moveTask: async (taskId, newLane) => {
    // Optimistic update
    set((state) => ({
      tasks: state.tasks.map(t => t.id === taskId ? { ...t, lane: newLane } : t),
    }));
    try {
      // acp-api's status endpoint expects { status }, not { lane } — sending lane
      // was silently ignored, so the move never persisted and reverted (#95).
      const res = await kanbanRequest(`/tasks/${taskId}/status`, {
        method: 'PUT',
        body: { status: laneToStatus(newLane) },
      });
      if (!res.ok) {
        // Surface the backend transition error instead of a silent revert (#95):
        // illegal moves (e.g. backlog->done, out-of-done) come back 400 with a
        // message; show it so the snap-back is explained.
        let message = `Couldn't move task (${res.status})`;
        try {
          const err = await res.json();
          message = err?.message || err?.error?.message || message;
        } catch { /* non-JSON body */ }
        useNotificationStore.getState().addNotification({
          type: 'system',
          title: 'Move not allowed',
          message,
        });
        await get().fetchTasks();
        return false;
      }
      return true;
    } catch (err) {
      console.error('[Kanban] Failed to move task:', err);
      useNotificationStore.getState().addNotification({
        type: 'system',
        title: 'Move failed',
        message: err instanceof Error ? err.message : 'Network error moving task',
      });
      await get().fetchTasks();
      return false;
    }
  },

  // #153-A archive = reversible soft-delete (Aurum's contract — NOT hard delete).
  // The acp-api board (GET /tasks) excludes archived by default, so a refetch drops
  // the task off the board; it stays in storage, restorable via unarchive. We refetch
  // BOTH lists from the server (not optimistic) so recoverable is true after a reload,
  // not just in-memory (QA 2752 E-gate). Fail-loud via notification.
  archiveTask: async (taskId) => {
    try {
      // POST (not PUT): the reconciled acp-api canonicalizes archive/unarchive to
      // POST /tasks/:id/(un)archive via one parametrized archiveTask handler (#152's
      // PUT pair was dropped in the wo1+master union — QA reconcile G2/G3 2825). PUT
      // 404/405s on the rebuilt backend.
      const res = await kanbanRequest(`/tasks/${taskId}/archive`, { method: 'POST' });
      if (!res.ok) {
        let message = `Couldn't archive task (${res.status})`;
        try {
          const err = await res.json();
          message = err?.message || err?.error?.message || message;
        } catch { /* non-JSON body */ }
        useNotificationStore.getState().addNotification({ type: 'system', title: 'Archive failed', message });
        return false;
      }
      // Drop it off the board + surface it in the Archived view (server is the truth).
      await Promise.all([get().fetchTasks(), get().fetchArchived()]);
      return true;
    } catch (err) {
      console.error('[Kanban] Failed to archive task:', err);
      useNotificationStore.getState().addNotification({
        type: 'system',
        title: 'Archive failed',
        message: err instanceof Error ? err.message : 'Network error archiving task',
      });
      return false;
    }
  },

  // #153-A restore = reverse the soft-delete. Non-destructive, so NO confirm in the UI
  // (asymmetric friction, Aurum 2747). The BE leaves status untouched, so the card
  // returns to its OWN column on refetch — we write NO lane here (no default-to-backlog).
  // Success names the destination column so the user SEES it land (closes the loop).
  unarchiveTask: async (taskId) => {
    // Capture the origin lane BEFORE the refetch clears it from archivedTasks, for the
    // "Restored to {column}" feedback. The lane was mapped from the BE-preserved status.
    const destLane = get().archivedTasks.find((t) => t.id === taskId)?.lane;
    try {
      const res = await kanbanRequest(`/tasks/${taskId}/unarchive`, { method: 'POST' });
      if (!res.ok) {
        let message = `Couldn't restore task (${res.status})`;
        try {
          const err = await res.json();
          message = err?.message || err?.error?.message || message;
        } catch { /* non-JSON body */ }
        useNotificationStore.getState().addNotification({ type: 'system', title: 'Restore failed', message });
        return false;
      }
      await Promise.all([get().fetchTasks(), get().fetchArchived()]);
      useNotificationStore.getState().addNotification({
        type: 'system',
        title: destLane ? `Restored to ${LANE_LABELS[destLane]}` : 'Task restored',
        message: 'The card is back on the board.',
      });
      return true;
    } catch (err) {
      console.error('[Kanban] Failed to restore task:', err);
      useNotificationStore.getState().addNotification({
        type: 'system',
        title: 'Restore failed',
        message: err instanceof Error ? err.message : 'Network error restoring task',
      });
      return false;
    }
  },

  updateFromSse: (data) => {
    // SSE kanban-update — refresh tasks
    if (data.tasks) {
      set({ tasks: data.tasks as KanbanTask[] });
    } else {
      get().fetchTasks();
    }
  },
}));

export function getTasksByLane(tasks: KanbanTask[], lane: KanbanLane): KanbanTask[] {
  return tasks.filter(t => t.lane === lane);
}

export function getPriorityColor(priority: KanbanPriority): string {
  switch (priority) {
    case 'critical': return 'text-red-400 bg-red-900/30 border-red-500/50';
    case 'high': return 'text-orange-400 bg-orange-900/30 border-orange-500/50';
    case 'medium': return 'text-yellow-400 bg-yellow-900/30 border-yellow-500/50';
    case 'low': default: return 'text-gray-400 bg-gray-900/30 border-gray-500/50';
  }
}
