import { create } from 'zustand';
import { KanbanBoard, KanbanTask, KanbanLane, KanbanPriority } from '@shared/types';
import { useAppStore } from './appStore';

// Helper to make authenticated requests to acp-api kanban endpoints
async function kanbanRequest(endpoint: string, options: { method?: string; body?: unknown } = {}): Promise<Response> {
  const { method = 'GET', body } = options;
  const secret = await window.electronAPI.getLocalSecret();
  return fetch(`http://127.0.0.1:3001/v1/kanban${endpoint}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(secret ? { 'Authorization': `Bearer ${secret}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

interface KanbanFilters {
  assignee?: string;
  priority?: KanbanPriority;
  milestone?: string;
}

interface KanbanStore {
  tasks: KanbanTask[];
  selectedTask: KanbanTask | null;
  isCreatingTask: boolean;
  filters: KanbanFilters;
  loading: boolean;
  error?: string;

  setSelectedTask: (task: KanbanTask | null) => void;
  setCreatingTask: (isCreating: boolean) => void;
  setFilters: (filters: Partial<KanbanFilters>) => void;

  fetchTasks: () => Promise<void>;
  createTask: (task: { title: string; description?: string; lane?: KanbanLane; priority?: KanbanPriority; assigned_agent_id?: number }) => Promise<boolean>;
  moveTask: (taskId: number, newLane: KanbanLane) => Promise<boolean>;
  updateFromSse: (data: Record<string, unknown>) => void;
}

export const useKanbanStore = create<KanbanStore>((set, get) => ({
  tasks: [],
  selectedTask: null,
  isCreatingTask: false,
  filters: {},
  loading: false,

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
      const tasks: KanbanTask[] = data.data?.tasks || data.data || data.tasks || [];
      set({ tasks, loading: false });
    } catch (err) {
      console.error('[Kanban] Failed to fetch tasks:', err);
      set({ loading: false, error: 'Failed to fetch tasks' });
    }
  },

  createTask: async (task) => {
    if (!useAppStore.getState().backendAvailable) return false;
    try {
      const res = await kanbanRequest('/tasks', { method: 'POST', body: task });
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
      const res = await kanbanRequest(`/tasks/${taskId}/status`, {
        method: 'PUT',
        body: { lane: newLane },
      });
      if (!res.ok) {
        // Revert on failure
        await get().fetchTasks();
        return false;
      }
      return true;
    } catch (err) {
      console.error('[Kanban] Failed to move task:', err);
      await get().fetchTasks();
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
    case 'urgent': return 'text-red-400 bg-red-900/30 border-red-500/50';
    case 'high': return 'text-orange-400 bg-orange-900/30 border-orange-500/50';
    case 'normal': return 'text-yellow-400 bg-yellow-900/30 border-yellow-500/50';
    case 'low': default: return 'text-gray-400 bg-gray-900/30 border-gray-500/50';
  }
}
