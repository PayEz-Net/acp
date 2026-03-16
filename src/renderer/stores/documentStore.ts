import { create } from 'zustand';
import type { AgentDocument, DocumentVersion } from '@shared/types';

interface DocumentStore {
  documents: AgentDocument[];
  activeDocument: AgentDocument | null;
  documentVersions: DocumentVersion[];
  showDocuments: boolean;
  showViewer: boolean;
  loading: boolean;
  error: string | null;

  // Actions
  setDocuments: (documents: AgentDocument[]) => void;
  setActiveDocument: (doc: AgentDocument | null) => void;
  setDocumentVersions: (versions: DocumentVersion[]) => void;
  toggleDocuments: () => void;
  openViewer: (doc: AgentDocument) => void;
  closeViewer: () => void;
  setLoading: (loading: boolean) => void;
  setError: (error: string | null) => void;
}

// Mock documents for development
const mockDocuments: AgentDocument[] = [
  {
    id: 1,
    title: 'Supervised Autonomy Frontend Spec',
    content_md: `# Supervised Autonomy Frontend Spec

## Overview

This document outlines the frontend components for supervised autonomous agent operation.

## Components

### 1. Mode Indicator
- Shows ATTENDED or AUTONOMOUS state
- Pulse animation when autonomous
- Click opens autonomy panel

### 2. Autonomy Panel
- Spec ID selection
- Milestone configuration
- Stop condition: milestone | blocker | time
- Max runtime slider (1-24 hours)
- Phone notification for alerts

### 3. Emergency Stop Button
- Floating red button
- Immediate stop without confirmation
- Only visible when autonomy enabled

### 4. Standup Sidebar
- Timeline of agent activities
- Filter by agent, event type, time
- Mark as reviewed functionality

## Implementation Status

- [x] Mode Indicator
- [x] Autonomy Panel
- [x] Emergency Stop Button
- [x] Standup Sidebar
- [ ] Notification Center wiring
- [ ] Document Viewer integration
`,
    type: 'spec',
    author_agent: 'BAPert',
    version: 2,
    created_at: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString(),
    updated_at: new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString(),
  },
  {
    id: 2,
    title: 'JWT Header Audit Report',
    content_md: `# JWT Header Audit Report

**Author:** QAPert
**Date:** ${new Date().toLocaleDateString()}

## Summary

Audit of JWT header handling across the PayEz codebase.

## Findings

### 1. Missing \`kid\` extraction (FIXED)
- Location: \`lib/jwt-decode.ts\`
- Issue: JWT header was decoded but \`kid\` field not extracted
- Fix: Added \`decodeJwtHeader()\` function

### 2. Session model update (FIXED)
- Location: \`models/SessionModel.ts:61\`
- Added \`bearerKeyId\` field to store extracted \`kid\`

### 3. Auth callback integration (FIXED)
- Location: \`auth/callbacks/jwt.ts:304\`
- Now extracts \`kid\` on login and stores in session

## Verification

All 9 files updated per spec. Build passes. Tests passing.

## Recommendation

Deploy to staging for integration testing.
`,
    type: 'report',
    author_agent: 'QAPert',
    version: 1,
    created_at: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
  },
  {
    id: 3,
    title: 'Day 2 Implementation Plan',
    content_md: `# Day 2 Implementation Plan

## Goals

1. Document Viewer integration
2. Notification Center wiring
3. AI Elements installation

## Tasks

### Document Viewer
- Create DocumentSidebar component
- Create DocumentModal for viewing
- Add proper markdown rendering with syntax highlighting
- Wire to mock data (backend not ready)

### Notifications
- Keep mock data for now
- Future: Wire to backend SSE/polling

### AI Elements
- Install Vercel AI Elements
- Use for future chat interfaces
- Components: conversation, message, response, code-block

## Timeline

- Task 1-3: DocumentSidebar + Modal
- Task 4-5: Markdown rendering
- Task 6-7: TitleBar integration
- Task 8: App.tsx wiring
- Task 9: Verification

## Dependencies

- DotNetPert: Backend endpoints (deferred)
- BAPert: Spec review
`,
    type: 'plan',
    author_agent: 'NextPert',
    version: 1,
    created_at: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
  },
  {
    id: 4,
    title: 'Code Review: Mail Push SSE',
    content_md: `# Code Review: Mail Push SSE Implementation

**Reviewer:** QAPert
**Status:** APPROVED

## Files Reviewed

1. \`src/renderer/hooks/useMailPush.ts\`
2. \`src/renderer/stores/appStore.ts\`
3. \`src/renderer/components/Layout/TitleBar.tsx\`

## Summary

Mail push via Server-Sent Events implementation is correct.

## Strengths

- Clean EventSource handling with proper cleanup
- Respects \`mailPushEnabled\` toggle
- Good error handling with reconnection logic
- Terminal injection for real-time notifications

## Minor Suggestions

1. Consider exponential backoff for reconnection
2. Add connection state indicator in UI

## Verdict

**APPROVED** - Ready for production.
`,
    type: 'review',
    author_agent: 'QAPert',
    version: 1,
    created_at: new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString(),
  },
  {
    id: 5,
    title: 'ACP Architecture Overview',
    content_md: `# ACP Architecture Overview

## System Components

\`\`\`
┌─────────────────────────────────────────────────────────────┐
│               Agent Collaboration Platform                   │
│                     (Electron + React)                       │
├─────────────────────────────────────────────────────────────┤
│  ┌─────────┐  ┌─────────┐  ┌─────────┐  ┌─────────┐       │
│  │ BAPert  │  │DotNetPrt│  │NextPert │  │ QAPert  │       │
│  │  PTY    │  │  PTY    │  │  PTY    │  │  PTY    │       │
│  └────┬────┘  └────┬────┘  └────┬────┘  └────┬────┘       │
│       │            │            │            │             │
│       └────────────┴────────────┴────────────┘             │
│                         │                                   │
│                    node-pty                                 │
└─────────────────────────────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────┐
│                    Agent Mail MCP                           │
│                  http://10.0.0.220:5050                     │
└─────────────────────────────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────┐
│                      Vibe API                               │
│               https://api.idealvibe.online                  │
│  ┌─────────┐  ┌─────────┐  ┌─────────┐  ┌─────────┐       │
│  │Autonomy │  │ Kanban  │  │  Docs   │  │Standup  │       │
│  └─────────┘  └─────────┘  └─────────┘  └─────────┘       │
└─────────────────────────────────────────────────────────────┘
\`\`\`

## Data Flow

1. **Agent Communication**: Mail MCP handles inter-agent messaging
2. **Task Management**: Kanban boards with drag-and-drop
3. **Documentation**: Specs, reports, reviews stored in Vibe SQL
4. **Autonomy**: Backend controls agent execution loops

## Key Features

- 4-pane terminal grid with xterm.js
- Real-time mail push via SSE
- Supervised autonomy with emergency stop
- Daily standup timeline
`,
    type: 'other',
    author_agent: 'BAPert',
    version: 1,
    created_at: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(),
  },
];

// Mock versions for the first document
const mockVersions: DocumentVersion[] = [
  {
    id: 1,
    document_id: 1,
    version: 2,
    content_md: mockDocuments[0].content_md,
    author_agent: 'BAPert',
    created_at: new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString(),
    change_summary: 'Added implementation status checklist',
  },
  {
    id: 2,
    document_id: 1,
    version: 1,
    content_md: '# Supervised Autonomy Frontend Spec\n\n## Overview\n\nInitial draft...',
    author_agent: 'BAPert',
    created_at: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString(),
    change_summary: 'Initial version',
  },
];

export const useDocumentStore = create<DocumentStore>((set) => ({
  documents: mockDocuments,
  activeDocument: null,
  documentVersions: [],
  showDocuments: false,
  showViewer: false,
  loading: false,
  error: null,

  setDocuments: (documents) => set({ documents }),

  setActiveDocument: (doc) => set({ activeDocument: doc }),

  setDocumentVersions: (versions) => set({ documentVersions: versions }),

  toggleDocuments: () => set((s) => ({ showDocuments: !s.showDocuments })),

  openViewer: (doc) => {
    // Load versions for this document (mock)
    const versions = doc.id === 1 ? mockVersions : [];
    set({
      activeDocument: doc,
      documentVersions: versions,
      showViewer: true,
    });
  },

  closeViewer: () => set({ showViewer: false, activeDocument: null, documentVersions: [] }),

  setLoading: (loading) => set({ loading }),

  setError: (error) => set({ error }),
}));
