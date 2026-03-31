import { create } from 'zustand';
import type { AgentDocument, DocumentVersion } from '@shared/types';
import { useAppStore } from './appStore';

interface DocumentStore {
  documents: AgentDocument[];
  activeDocument: AgentDocument | null;
  documentVersions: DocumentVersion[];
  showDocuments: boolean;
  showViewer: boolean;
  loading: boolean;
  error: string | null;

  // Actions
  fetchDocuments: () => Promise<void>;
  setDocuments: (documents: AgentDocument[]) => void;
  setActiveDocument: (doc: AgentDocument | null) => void;
  setDocumentVersions: (versions: DocumentVersion[]) => void;
  toggleDocuments: () => void;
  openViewer: (doc: AgentDocument) => void;
  closeViewer: () => void;
  setLoading: (loading: boolean) => void;
  setError: (error: string | null) => void;
}

async function documentRequest(endpoint: string): Promise<Response> {
  const secret = await window.electronAPI.getLocalSecret();
  return fetch(`http://127.0.0.1:3001/v1/documents${endpoint}`, {
    headers: {
      'Content-Type': 'application/json',
      ...(secret ? { 'Authorization': `Bearer ${secret}` } : {}),
    },
  });
}

export const useDocumentStore = create<DocumentStore>((set) => ({
  documents: [],
  activeDocument: null,
  documentVersions: [],
  showDocuments: false,
  showViewer: false,
  loading: false,
  error: null,

  fetchDocuments: async () => {
    if (!useAppStore.getState().backendAvailable) return;
    set({ loading: true, error: null });
    try {
      const res = await documentRequest('/');
      if (!res.ok) throw new Error(`${res.status}`);
      const data = await res.json();
      const docs: AgentDocument[] = data.data || [];
      set({ documents: docs, loading: false });
    } catch (err) {
      console.error('[Documents] Failed to fetch:', err);
      set({ loading: false, error: 'Failed to fetch documents' });
    }
  },

  setDocuments: (documents) => set({ documents }),

  setActiveDocument: (doc) => set({ activeDocument: doc }),

  setDocumentVersions: (versions) => set({ documentVersions: versions }),

  toggleDocuments: () => set((s) => ({ showDocuments: !s.showDocuments })),

  openViewer: (doc) => {
    set({
      activeDocument: doc,
      documentVersions: [],
      showViewer: true,
    });
  },

  closeViewer: () => set({ showViewer: false, activeDocument: null, documentVersions: [] }),

  setLoading: (loading) => set({ loading }),

  setError: (error) => set({ error }),
}));
