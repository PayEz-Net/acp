import { create } from 'zustand';
import { KanbanBoard, KanbanTask, KanbanStatus, KanbanPriority } from '@shared/types';

const VIBE_API = 'https://api.idealvibe.online/api/vibe';
const USE_MOCK_DATA = true; // Set to false when backend is ready

// Mock data for demo
const MOCK_BOARDS: KanbanBoard[] = [
  { board_id: 1, name: 'Vibe Agents Sprint', created_at: new Date().toISOString() },
];

const MOCK_TASKS: KanbanTask[] = [
  { task_id: 1, board_id: 1, title: 'Vibe Agents Backend Endpoints', status: 'IN_PROGRESS', priority: 'high', assigned_agent_id: '2', assigned_agent_name: 'DotNetPert', created_at: new Date().toISOString() },
  { task_id: 2, board_id: 1, title: 'Provision vibe_agents schema', status: 'TODO', priority: 'urgent', assigned_agent_id: '2', assigned_agent_name: 'DotNetPert', created_at: new Date().toISOString() },
  { task_id: 3, board_id: 1, title: 'Phase 4: Keyboard shortcuts', status: 'TODO', priority: 'medium', assigned_agent_id: '3', assigned_agent_name: 'NextPert', created_at: new Date().toISOString() },
  { task_id: 4, board_id: 1, title: 'Code review Phase 3', status: 'IN_PROGRESS', priority: 'high', assigned_agent_id: '4', assigned_agent_name: 'QAPert', created_at: new Date().toISOString() },
  { task_id: 5, board_id: 1, title: 'Phase 1: Terminal Grid', status: 'DONE', priority: 'high', assigned_agent_id: '3', assigned_agent_name: 'NextPert', created_at: new Date(Date.now() - 86400000).toISOString() },
  { task_id: 6, board_id: 1, title: 'Phase 2: Mail Sidebar', status: 'DONE', priority: 'high', assigned_agent_id: '3', assigned_agent_name: 'NextPert', created_at: new Date(Date.now() - 43200000).toISOString() },
  { task_id: 7, board_id: 1, title: 'Phase 3: Kanban Sidebar', status: 'DONE', priority: 'high', assigned_agent_id: '3', assigned_agent_name: 'NextPert', created_at: new Date(Date.now() - 3600000).toISOString() },
];

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

    // Use mock data for demo
    if (USE_MOCK_DATA) {
      await new Promise((r) => setTimeout(r, 300));
      set({ boards: MOCK_BOARDS, loading: false, selectedBoard: MOCK_BOARDS[0] });
      get().fetchTasks(MOCK_BOARDS[0].board_id);
      return;
    }

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

    // Use mock data for demo
    if (USE_MOCK_DATA) {
      await new Promise((r) => setTimeout(r, 200));
      const tasks = MOCK_TASKS.filter((t) => t.board_id === boardId);
      set({ tasks, loading: false });
      return;
    }

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
    // Mock mode - just update local state
    if (USE_MOCK_DATA) {
      set((state) => ({
        tasks: state.tasks.map((t) =>
          t.task_id === taskId ? { ...t, ...updates, updated_at: new Date().toISOString() } : t
        )
      }));
      return true;
    }

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
