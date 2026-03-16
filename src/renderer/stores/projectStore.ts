import { create } from 'zustand';
import { useAppStore } from './appStore';

// --- Types ---

export interface Project {
  id: number;
  name: string;
  description?: string;
  status: 'active' | 'archived' | 'completed';
  created_at: string;
  updated_at: string;
}

// --- API helper ---

async function projectRequest(endpoint: string, options: { method?: string; body?: unknown } = {}): Promise<Response> {
  const { method = 'GET', body } = options;
  const secret = await window.electronAPI.getLocalSecret();
  return fetch(`http://127.0.0.1:3001/v1/projects${endpoint}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(secret ? { 'Authorization': `Bearer ${secret}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

// --- Store ---

interface ProjectStore {
  // State
  projects: Project[];
  activeProject: Project | null;
  loading: boolean;
  showPicker: boolean;

  // Actions
  setShowPicker: (show: boolean) => void;

  // API
  fetchProjects: () => Promise<void>;
  fetchActiveProject: () => Promise<void>;
  switchProject: (projectId: number) => Promise<boolean>;
  createProject: (name: string, description?: string) => Promise<Project | null>;
  updateProject: (projectId: number, updates: { name?: string; description?: string; status?: string }) => Promise<boolean>;

  // SSE
  handleProjectSwitched: (data: Record<string, unknown>) => void;
}

export const useProjectStore = create<ProjectStore>((set, get) => ({
  projects: [],
  activeProject: null,
  loading: false,
  showPicker: false,

  setShowPicker: (show) => set({ showPicker: show }),

  fetchProjects: async () => {
    if (!useAppStore.getState().backendAvailable) return;
    set({ loading: true });
    try {
      const res = await projectRequest('');
      if (!res.ok) throw new Error(`${res.status}`);
      const data = await res.json();
      const projects: Project[] = data.data?.projects || data.data || [];
      set({ projects, loading: false });
    } catch (err) {
      console.error('[Projects] Failed to fetch projects:', err);
      set({ loading: false });
    }
  },

  fetchActiveProject: async () => {
    if (!useAppStore.getState().backendAvailable) return;
    try {
      const res = await projectRequest('/active');
      if (!res.ok) throw new Error(`${res.status}`);
      const data = await res.json();
      const project: Project | null = data.data?.project || data.data || null;
      set({ activeProject: project });
      // If no active project, show picker
      if (!project) set({ showPicker: true });
    } catch (err) {
      console.error('[Projects] Failed to fetch active project:', err);
      set({ showPicker: true });
    }
  },

  switchProject: async (projectId) => {
    if (!useAppStore.getState().backendAvailable) return false;
    try {
      const res = await projectRequest('/active', {
        method: 'POST',
        body: { project_id: projectId },
      });
      if (!res.ok) throw new Error(`${res.status}`);
      const data = await res.json();
      const project: Project | null = data.data?.project || data.data || null;
      set({ activeProject: project, showPicker: false });
      // Reload all project-scoped stores
      await reloadProjectScopedStores();
      return true;
    } catch (err) {
      console.error('[Projects] Failed to switch project:', err);
      return false;
    }
  },

  createProject: async (name, description) => {
    if (!useAppStore.getState().backendAvailable) return null;
    try {
      const res = await projectRequest('', {
        method: 'POST',
        body: { name, description },
      });
      if (!res.ok) throw new Error(`${res.status}`);
      const data = await res.json();
      const project: Project = data.data?.project || data.data;
      await get().fetchProjects();
      return project;
    } catch (err) {
      console.error('[Projects] Failed to create project:', err);
      return null;
    }
  },

  updateProject: async (projectId, updates) => {
    if (!useAppStore.getState().backendAvailable) return false;
    try {
      const res = await projectRequest(`/${projectId}`, {
        method: 'PATCH',
        body: updates,
      });
      if (!res.ok) throw new Error(`${res.status}`);
      await get().fetchProjects();
      // Refresh active if we updated it
      if (get().activeProject?.id === projectId) {
        await get().fetchActiveProject();
      }
      return true;
    } catch (err) {
      console.error('[Projects] Failed to update project:', err);
      return false;
    }
  },

  handleProjectSwitched: (data) => {
    const projectId = data.project_id as number;
    const projectName = data.project_name as string;
    if (projectId && get().activeProject?.id !== projectId) {
      set({
        activeProject: {
          ...get().activeProject!,
          id: projectId,
          name: projectName || get().activeProject?.name || '',
        },
      });
      reloadProjectScopedStores();
    }
  },
}));

// --- Reload all project-scoped stores ---

async function reloadProjectScopedStores() {
  const { useKanbanStore } = await import('./kanbanStore');
  const { useContractorStore } = await import('./contractorStore');
  const { useChatStore } = await import('./chatStore');
  const { useStandupStore } = await import('./standupStore');

  const promises: Promise<void>[] = [];

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const kanbanState = useKanbanStore.getState() as any;
  if (typeof kanbanState.fetchTasks === 'function') {
    promises.push(kanbanState.fetchTasks());
  }

  promises.push(useContractorStore.getState().fetchActive());

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const chatState = useChatStore.getState() as any;
  if (typeof chatState.fetchConversations === 'function') {
    promises.push(chatState.fetchConversations());
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const standupState = useStandupStore.getState() as any;
  if (typeof standupState.fetchStandups === 'function') {
    promises.push(standupState.fetchStandups());
  }

  await Promise.allSettled(promises);
}
