import { create } from 'zustand';
import { KanbanBoard, KanbanTask, KanbanLane, KanbanPriority } from '@shared/types';
import { getAuthToken } from '../services/api';

const VIBE_API = 'http://localhost:37933/api/vibe';
const USE_MOCK_DATA = false;

// Helper to make authenticated requests
async function vibeRequest(endpoint: string, body: unknown) {
  const token = getAuthToken();
  const res = await fetch(`${VIBE_API}${endpoint}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { 'Authorization': `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  return res;
}

// Mock data for demo/fallback
const MOCK_BOARDS: KanbanBoard[] = [
  { id: 1, name: 'Vibe Agents Sprint', created_at: new Date().toISOString() },
];

const MOCK_TASKS: KanbanTask[] = [
  { id: 1, board_id: 1, title: 'Vibe Agents Backend Endpoints', lane: 'in_progress', priority: 'high', assigned_agent_id: 2, created_at: new Date().toISOString() },
  { id: 2, board_id: 1, title: 'Provision vibe_agents schema', lane: 'backlog', priority: 'urgent', assigned_agent_id: 2, created_at: new Date().toISOString() },
  { id: 3, board_id: 1, title: 'Phase 4: Keyboard shortcuts', lane: 'ready', priority: 'normal', assigned_agent_id: 3, created_at: new Date().toISOString() },
  { id: 4, board_id: 1, title: 'Code review Phase 3', lane: 'review', priority: 'high', assigned_agent_id: 4, created_at: new Date().toISOString() },
  { id: 5, board_id: 1, title: 'Phase 1: Terminal Grid', lane: 'done', priority: 'high', assigned_agent_id: 3, created_at: new Date(Date.now() - 86400000).toISOString() },
  { id: 6, board_id: 1, title: 'Phase 2: Mail Sidebar', lane: 'done', priority: 'high', assigned_agent_id: 3, created_at: new Date(Date.now() - 43200000).toISOString() },
  { id: 7, board_id: 1, title: 'Phase 3: Kanban Sidebar', lane: 'done', priority: 'high', assigned_agent_id: 3, created_at: new Date(Date.now() - 3600000).toISOString() },
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
  createTask: (task: Omit<KanbanTask, 'id' | 'created_at'>) => Promise<boolean>;
  updateTask: (taskId: number, updates: Partial<KanbanTask>) => Promise<boolean>;
  moveTask: (taskId: number, newLane: KanbanLane) => Promise<boolean>;
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
      get().fetchTasks(MOCK_BOARDS[0].id);
      return;
    }

    try {
      const res = await vibeRequest('/query', {
        collection: 'agent_kanban_boards',
        sort: { created_at: 'desc' },
        limit: 50
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
        get().fetchTasks(boards[0].id);
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
      const res = await vibeRequest('/query', {
        collection: 'agent_kanban_tasks',
        filter: { board_id: boardId },
        sort: { created_at: 'desc' },
        limit: 100
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
      const res = await vibeRequest('/insert', {
        collection: 'agent_kanban_tasks',
        data: {
          ...task,
          created_at: new Date().toISOString()
        }
      });

      if (!res.ok) {
        throw new Error(`Failed to create task: ${res.status}`);
      }

      // Refresh tasks
      const { selectedBoard } = get();
      if (selectedBoard) {
        await get().fetchTasks(selectedBoard.id);
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
          t.id === taskId ? { ...t, ...updates, updated_at: new Date().toISOString() } : t
        )
      }));
      return true;
    }

    try {
      const res = await vibeRequest('/update', {
        collection: 'agent_kanban_tasks',
        filter: { id: taskId },
        data: {
          ...updates,
          updated_at: new Date().toISOString()
        }
      });

      if (!res.ok) {
        throw new Error(`Failed to update task: ${res.status}`);
      }

      // Update local state optimistically
      set((state) => ({
        tasks: state.tasks.map((t) =>
          t.id === taskId ? { ...t, ...updates } : t
        )
      }));

      return true;
    } catch (err) {
      console.error('[Kanban] Failed to update task:', err);
      return false;
    }
  },

  moveTask: async (taskId, newLane) => {
    // Optimistic update
    set((state) => ({
      tasks: state.tasks.map((t) =>
        t.id === taskId ? { ...t, lane: newLane } : t
      )
    }));

    const success = await get().updateTask(taskId, { lane: newLane });

    if (!success) {
      // Revert on failure - refetch tasks
      const { selectedBoard } = get();
      if (selectedBoard) {
        await get().fetchTasks(selectedBoard.id);
      }
    }

    return success;
  },

  deleteTask: async (taskId) => {
    try {
      const res = await vibeRequest('/delete', {
        collection: 'agent_kanban_tasks',
        filter: { id: taskId }
      });

      if (!res.ok) {
        throw new Error(`Failed to delete task: ${res.status}`);
      }

      // Remove from local state
      set((state) => ({
        tasks: state.tasks.filter((t) => t.id !== taskId),
        selectedTask: state.selectedTask?.id === taskId ? null : state.selectedTask
      }));

      return true;
    } catch (err) {
      console.error('[Kanban] Failed to delete task:', err);
      return false;
    }
  }
}));

// Helper to get tasks by lane
export function getTasksByLane(tasks: KanbanTask[], lane: KanbanLane): KanbanTask[] {
  return tasks.filter((t) => t.lane === lane);
}

// Helper to get priority color
export function getPriorityColor(priority: KanbanPriority): string {
  switch (priority) {
    case 'urgent':
      return 'text-red-400 bg-red-900/30 border-red-500/50';
    case 'high':
      return 'text-orange-400 bg-orange-900/30 border-orange-500/50';
    case 'normal':
      return 'text-yellow-400 bg-yellow-900/30 border-yellow-500/50';
    case 'low':
    default:
      return 'text-gray-400 bg-gray-900/30 border-gray-500/50';
  }
}
