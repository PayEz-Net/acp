import { create } from 'zustand';
import {
  ACPAgent,
  ACPAgentStatus,
  ACPCharacter,
  ACPChatMessage,
  ACPEvent,
  ACPEventType,
  ACPPosition,
  ACPZone,
  ACP_CHARACTERS,
  ACP_ZONES,
} from '@shared/types';

// Generate unique ID
const generateId = () => Math.random().toString(36).substring(2, 9);

// Get zone center position
const getZoneCenter = (zone: ACPZone): ACPPosition => {
  const zoneConfig = ACP_ZONES.find((z) => z.id === zone);
  if (!zoneConfig) return { x: 50, y: 50 };
  return {
    x: zoneConfig.bounds.x + zoneConfig.bounds.width / 2,
    y: zoneConfig.bounds.y + zoneConfig.bounds.height / 2,
  };
};

// Initial agent positions
const createInitialAgents = (): ACPAgent[] => {
  const characters: ACPCharacter[] = ['sage', 'forge', 'pixel', 'nova', 'raven'];
  const initialZones: ACPZone[] = ['table-db', 'table-api', 'table-ui', 'lounge', 'bar'];

  return characters.map((char, index) => {
    const config = ACP_CHARACTERS[char];
    const zone = initialZones[index];
    const position = getZoneCenter(zone);
    // Add slight offset to prevent overlap
    position.x += (Math.random() - 0.5) * 8;
    position.y += (Math.random() - 0.5) * 8;

    return {
      id: config.agentName.toLowerCase(),
      character: char,
      agentName: config.agentName,
      position,
      zone,
      status: index < 3 ? 'working' : 'idle',
      currentTask: index < 3 ? `Working on ${zone.replace('table-', '')} tasks` : undefined,
      taskProgress: index < 3 ? Math.floor(Math.random() * 60) + 20 : undefined,
      selected: false,
    };
  });
};

interface ACPStore {
  // State
  agents: ACPAgent[];
  selectedAgentId: string | null;
  events: ACPEvent[];
  chatMessages: Map<string, ACPChatMessage[]>;
  isPaused: boolean;
  projectProgress: number;

  // Actions
  selectAgent: (agentId: string | null) => void;
  updateAgentPosition: (agentId: string, position: ACPPosition) => void;
  updateAgentStatus: (agentId: string, status: ACPAgentStatus) => void;
  updateAgentZone: (agentId: string, zone: ACPZone) => void;
  updateAgentTask: (agentId: string, task: string | undefined, progress?: number) => void;
  setAgentMingling: (agentId: string, targetAgentId: string | undefined) => void;
  pauseAgent: (agentId: string) => void;
  resumeAgent: (agentId: string) => void;
  togglePause: () => void;
  addEvent: (type: ACPEventType, message: string, agentId?: string, targetAgentId?: string, details?: string) => void;
  addChatMessage: (agentId: string, message: Omit<ACPChatMessage, 'id' | 'timestamp'>) => void;
  updateChatMessage: (agentId: string, messageId: string, content: string, streaming?: boolean) => void;
  clearEvents: () => void;
  setProjectProgress: (progress: number) => void;
}

export const useACPStore = create<ACPStore>((set, get) => ({
  // Initial state
  agents: createInitialAgents(),
  selectedAgentId: null,
  events: [
    {
      id: generateId(),
      type: 'system',
      timestamp: new Date(),
      message: 'Agent Collaboration Platform initialized',
    },
    {
      id: generateId(),
      type: 'agent_entered',
      timestamp: new Date(Date.now() - 60000),
      agentId: 'nova',
      agentName: 'Nova',
      message: 'Nova arrived at the party in fresh sneakers',
    },
    {
      id: generateId(),
      type: 'agent_working',
      timestamp: new Date(Date.now() - 120000),
      agentId: 'pixel',
      agentName: 'Pixel',
      message: 'Pixel initialized the Tailwind configuration',
    },
    {
      id: generateId(),
      type: 'agent_working',
      timestamp: new Date(Date.now() - 180000),
      agentId: 'sage',
      agentName: 'Sage',
      message: 'Sage synthesized DB Schema from PAYEZ project specs',
    },
  ],
  chatMessages: new Map(),
  isPaused: false,
  projectProgress: 75,

  // Actions
  selectAgent: (agentId) =>
    set((state) => ({
      agents: state.agents.map((a) => ({
        ...a,
        selected: a.id === agentId,
      })),
      selectedAgentId: agentId,
    })),

  updateAgentPosition: (agentId, position) =>
    set((state) => ({
      agents: state.agents.map((a) =>
        a.id === agentId ? { ...a, position } : a
      ),
    })),

  updateAgentStatus: (agentId, status) =>
    set((state) => ({
      agents: state.agents.map((a) =>
        a.id === agentId ? { ...a, status } : a
      ),
    })),

  updateAgentZone: (agentId, zone) => {
    const agent = get().agents.find((a) => a.id === agentId);
    if (!agent) return;

    const newPosition = getZoneCenter(zone);
    newPosition.x += (Math.random() - 0.5) * 8;
    newPosition.y += (Math.random() - 0.5) * 8;

    set((state) => ({
      agents: state.agents.map((a) =>
        a.id === agentId
          ? { ...a, zone, targetPosition: newPosition, status: 'moving' }
          : a
      ),
    }));

    // Add movement event
    get().addEvent(
      'agent_moved',
      `${agent.agentName} moved to ${zone.replace('table-', '').replace('-', ' ')}`,
      agentId
    );
  },

  updateAgentTask: (agentId, task, progress) =>
    set((state) => ({
      agents: state.agents.map((a) =>
        a.id === agentId
          ? { ...a, currentTask: task, taskProgress: progress }
          : a
      ),
    })),

  setAgentMingling: (agentId, targetAgentId) => {
    const agent = get().agents.find((a) => a.id === agentId);
    const targetAgent = targetAgentId
      ? get().agents.find((a) => a.id === targetAgentId)
      : undefined;

    set((state) => ({
      agents: state.agents.map((a) => {
        if (a.id === agentId) {
          return {
            ...a,
            minglingWith: targetAgentId,
            status: targetAgentId ? 'mingling' : a.status === 'mingling' ? 'idle' : a.status,
          };
        }
        if (a.id === targetAgentId) {
          return {
            ...a,
            minglingWith: agentId,
            status: 'mingling',
          };
        }
        return a;
      }),
    }));

    if (targetAgent) {
      get().addEvent(
        'mingle_started',
        `${agent?.agentName} started coordinating with ${targetAgent.agentName}`,
        agentId,
        targetAgentId
      );
    }
  },

  pauseAgent: (agentId) => {
    const agent = get().agents.find((a) => a.id === agentId);
    set((state) => ({
      agents: state.agents.map((a) =>
        a.id === agentId ? { ...a, status: 'paused' } : a
      ),
    }));
    if (agent) {
      get().addEvent('system', `${agent.agentName} paused - waiting for input`, agentId);
    }
  },

  resumeAgent: (agentId) => {
    const agent = get().agents.find((a) => a.id === agentId);
    set((state) => ({
      agents: state.agents.map((a) =>
        a.id === agentId ? { ...a, status: a.currentTask ? 'working' : 'idle' } : a
      ),
    }));
    if (agent) {
      get().addEvent('system', `${agent.agentName} resumed`, agentId);
    }
  },

  togglePause: () => set((state) => ({ isPaused: !state.isPaused })),

  addEvent: (type, message, agentId, targetAgentId, details) => {
    const agent = agentId ? get().agents.find((a) => a.id === agentId) : undefined;
    const targetAgent = targetAgentId ? get().agents.find((a) => a.id === targetAgentId) : undefined;

    set((state) => ({
      events: [
        {
          id: generateId(),
          type,
          timestamp: new Date(),
          agentId,
          agentName: agent?.agentName,
          targetAgentId,
          targetAgentName: targetAgent?.agentName,
          message,
          details,
        },
        ...state.events,
      ].slice(0, 100), // Keep last 100 events
    }));
  },

  addChatMessage: (agentId, message) => {
    const newMessage: ACPChatMessage = {
      ...message,
      id: generateId(),
      timestamp: new Date(),
    };

    set((state) => {
      const messages = new Map(state.chatMessages);
      const agentMessages = messages.get(agentId) || [];
      messages.set(agentId, [...agentMessages, newMessage]);
      return { chatMessages: messages };
    });

    // Add to event log if it's a user message
    if (message.role === 'user') {
      const agent = get().agents.find((a) => a.id === agentId);
      get().addEvent('human_message', `Human messaged ${agent?.agentName}`, agentId);
    }
  },

  updateChatMessage: (agentId, messageId, content, streaming) =>
    set((state) => {
      const messages = new Map(state.chatMessages);
      const agentMessages = messages.get(agentId) || [];
      messages.set(
        agentId,
        agentMessages.map((m) =>
          m.id === messageId ? { ...m, content, streaming } : m
        )
      );
      return { chatMessages: messages };
    }),

  clearEvents: () => set({ events: [] }),

  setProjectProgress: (progress) => set({ projectProgress: progress }),
}));
