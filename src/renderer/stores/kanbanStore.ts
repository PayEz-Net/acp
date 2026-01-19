import { create } from 'zustand';
import { KanbanBoard, KanbanTask, KanbanStatus, KanbanPriority } from '@shared/types';

const VIBE_API = 'https://api.idealvibe.online/api/vibe';

interface KanbanStore {
  // State
  boards: KanbanBoard[];
  tasks: KanbanTask[];
  selectedBoard: KanbanBoard | null;
  selectedTask: KanbanTask | null;
  isCreatingTask: boolean;
  loading: boolean;
  error?: string;

  // Actions
  setSelectedBoard: (board: KanbanBoard | null) => void;
  setSelectedTask: (task: KanbanTask | null) => void;
  setCreatingTask: (isCreating: boolean) => void;

  // API actions
  fetchBoards: () => Promise<void>;
  fetchTasks: (boardId: number) => Promise<void>;
  createTask: (task: Omit<KanbanTask, 'task_id' | 'created_at'>) => Promise<boolean>;
  updateTask: (taskId: number, updates: Partial<KanbanTask>) => Promise<boolean>;
  moveTask: (taskId: number, newStatus: KanbanStatus) => Promise<boolean>;
  deleteTask: (taskId: number) => Promise<boolean>;
}

export const useKanbanStore = create<KanbanStore>((set, get) => ({
  boards: [],
  tasks: [],
  selectedBoard: null,
  selectedTask: null,
  isCreatingTask: false,
  loading: false,
  error: undefined,

  setSelectedBoard: (board) => set({ selectedBoard: board }),
  setSelectedTask: (task) => set({ selectedTask: task, isCreatingTask: false }),
  setCreatingTask: (isCreating) => set({ isCreatingTask: isCreating, selectedTask: null }),

  fetchBoards: async () => {
    set({ loading: true, error: undefined });

    try {
      const res = await fetch(`${VIBE_API}/query`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          collection: 'agent_kanban_boards',
          sort: { created_at: 'desc' },
          limit: 50
        })
      });

      if (!res.ok) {
        throw new Error(`Failed to fetch boards: ${res.status}`);
      }

      const data = await res.json();
      const boards: KanbanBoard[] = data.items || [];

      set({ boards, loading: false });

      // Auto-select first board if none selected
      const { selectedBoard } = get();
      if (!selectedBoard && boards.length > 0) {
        set({ selectedBoard: boards[0] });
        get().fetchTasks(boards[0].board_id);
      }
    } catch (err) {
      console.error('[Kanban] Failed to fetch boards:', err);
      set({
        loading: false,
        error: err instanceof Error ? err.message : 'Failed to fetch boards'
      });
    }
  },

  fetchTasks: async (boardId) => {
    set({ loading: true, error: undefined });

    try {
      const res = await fetch(`${VIBE_API}/query`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          collection: 'agent_kanban_tasks',
          filter: { board_id: boardId },
          sort: { created_at: 'desc' },
          limit: 100
        })
      });

      if (!res.ok) {
        throw new Error(`Failed to fetch tasks: ${res.status}`);
      }

      const data = await res.json();
      const tasks: KanbanTask[] = data.items || [];

      set({ tasks, loading: false });
    } catch (err) {
      console.error('[Kanban] Failed to fetch tasks:', err);
      set({
        loading: false,
        error: err instanceof Error ? err.message : 'Failed to fetch tasks'
      });
    }
  },

  createTask: async (task) => {
    try {
      const res = await fetch(`${VIBE_API}/insert`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          collection: 'agent_kanban_tasks',
          data: {
            ...task,
            created_at: new Date().toISOString()
          }
        })
      });

      if (!res.ok) {
        throw new Error(`Failed to create task: ${res.status}`);
      }

      // Refresh tasks
      const { selectedBoard } = get();
      if (selectedBoard) {
        await get().fetchTasks(selectedBoard.board_id);
      }

      return true;
    } catch (err) {
      console.error('[Kanban] Failed to create task:', err);
      return false;
    }
  },

  updateTask: async (taskId, updates) => {
    try {
      const res = await fetch(`${VIBE_API}/update`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          collection: 'agent_kanban_tasks',
          filter: { task_id: taskId },
          data: {
            ...updates,
            updated_at: new Date().toISOString()
          }
        })
      });

      if (!res.ok) {
        throw new Error(`Failed to update task: ${res.status}`);
      }

      // Update local state optimistically
      set((state) => ({
        tasks: state.tasks.map((t) =>
          t.task_id === taskId ? { ...t, ...updates } : t
        )
      }));

      return true;
    } catch (err) {
      console.error('[Kanban] Failed to update task:', err);
      return false;
    }
  },

  moveTask: async (taskId, newStatus) => {
    // Optimistic update
    set((state) => ({
      tasks: state.tasks.map((t) =>
        t.task_id === taskId ? { ...t, status: newStatus } : t
      )
    }));

    const success = await get().updateTask(taskId, { status: newStatus });

    if (!success) {
      // Revert on failure - refetch tasks
      const { selectedBoard } = get();
      if (selectedBoard) {
        await get().fetchTasks(selectedBoard.board_id);
      }
    }

    return success;
  },

  deleteTask: async (taskId) => {
    try {
      const res = await fetch(`${VIBE_API}/delete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          collection: 'agent_kanban_tasks',
          filter: { task_id: taskId }
        })
      });

      if (!res.ok) {
        throw new Error(`Failed to delete task: ${res.status}`);
      }

      // Remove from local state
      set((state) => ({
        tasks: state.tasks.filter((t) => t.task_id !== taskId),
        selectedTask: state.selectedTask?.task_id === taskId ? null : state.selectedTask
      }));

      return true;
    } catch (err) {
      console.error('[Kanban] Failed to delete task:', err);
      return false;
    }
  }
}));

// Helper to get tasks by status
export function getTasksByStatus(tasks: KanbanTask[], status: KanbanStatus): KanbanTask[] {
  return tasks.filter((t) => t.status === status);
}

// Helper to get priority color
export function getPriorityColor(priority: KanbanPriority): string {
  switch (priority) {
    case 'urgent':
      return 'text-red-400 bg-red-900/30 border-red-500/50';
    case 'high':
      return 'text-orange-400 bg-orange-900/30 border-orange-500/50';
    case 'medium':
      return 'text-yellow-400 bg-yellow-900/30 border-yellow-500/50';
    case 'low':
    default:
      return 'text-gray-400 bg-gray-900/30 border-gray-500/50';
  }
}
