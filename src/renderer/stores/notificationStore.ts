import { create } from 'zustand';
import type { Notification } from '@shared/types';

interface NotificationStore {
  notifications: Notification[];
  unreadCount: number;
  isOpen: boolean;

  // Actions
  setNotifications: (notifications: Notification[]) => void;
  addNotification: (notification: Omit<Notification, 'id' | 'created_at' | 'read'>) => void;
  markAsRead: (id: number) => void;
  markAllAsRead: () => void;
  removeNotification: (id: number) => void;
  clearAll: () => void;
  toggleOpen: () => void;
  setOpen: (open: boolean) => void;
}

// Mock notifications for development
const mockNotifications: Notification[] = [
  {
    id: 1,
    type: 'mail',
    title: 'New message from BAPert',
    message: 'TASK: Integrate @vibe/agent-ui components',
    agent: 'BAPert',
    read: false,
    created_at: new Date(Date.now() - 5 * 60000).toISOString(), // 5 min ago
  },
  {
    id: 2,
    type: 'review',
    title: 'Code review approved',
    message: 'QAPert approved your Mail Push SSE implementation',
    agent: 'QAPert',
    read: false,
    created_at: new Date(Date.now() - 30 * 60000).toISOString(), // 30 min ago
  },
  {
    id: 3,
    type: 'task',
    title: 'Task assigned',
    message: 'Day 2 - Document Viewer + Notifications',
    agent: 'BAPert',
    link: '/kanban/task/42',
    read: true,
    created_at: new Date(Date.now() - 2 * 3600000).toISOString(), // 2 hours ago
  },
  {
    id: 4,
    type: 'system',
    title: 'Autonomy mode enabled',
    message: 'All agents are now running autonomously until milestone completion',
    read: true,
    created_at: new Date(Date.now() - 4 * 3600000).toISOString(), // 4 hours ago
  },
];

export const useNotificationStore = create<NotificationStore>((set) => ({
  notifications: mockNotifications,
  unreadCount: mockNotifications.filter((n) => !n.read).length,
  isOpen: false,

  setNotifications: (notifications) =>
    set({
      notifications,
      unreadCount: notifications.filter((n) => !n.read).length,
    }),

  addNotification: (notification) => {
    const newNotification: Notification = {
      ...notification,
      id: Date.now(),
      read: false,
      created_at: new Date().toISOString(),
    };
    set((state) => ({
      notifications: [newNotification, ...state.notifications],
      unreadCount: state.unreadCount + 1,
    }));
  },

  markAsRead: (id) =>
    set((state) => {
      const notifications = state.notifications.map((n) =>
        n.id === id ? { ...n, read: true } : n
      );
      return {
        notifications,
        unreadCount: notifications.filter((n) => !n.read).length,
      };
    }),

  markAllAsRead: () =>
    set((state) => ({
      notifications: state.notifications.map((n) => ({ ...n, read: true })),
      unreadCount: 0,
    })),

  removeNotification: (id) =>
    set((state) => {
      const notifications = state.notifications.filter((n) => n.id !== id);
      return {
        notifications,
        unreadCount: notifications.filter((n) => !n.read).length,
      };
    }),

  clearAll: () => set({ notifications: [], unreadCount: 0 }),

  toggleOpen: () => set((state) => ({ isOpen: !state.isOpen })),

  setOpen: (open) => set({ isOpen: open }),
}));
