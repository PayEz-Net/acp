import { useEffect, useCallback } from 'react';
import { useKanbanStore, getTasksByLane } from '../stores/kanbanStore';
import { KanbanLane, KanbanPriority } from '@shared/types';

interface UseKanbanOptions {
  pollInterval?: number;
  enabled?: boolean;
}

export function useKanban({ pollInterval = 10000, enabled = true }: UseKanbanOptions = {}) {
  const {
    tasks,
    selectedTask,
    isCreatingTask,
    loading,
    error,
    setSelectedTask,
    setCreatingTask,
    fetchTasks,
    createTask,
    moveTask,
  } = useKanbanStore();

  // Initial fetch and polling
  useEffect(() => {
    if (!enabled) return;
    fetchTasks();
    const interval = setInterval(fetchTasks, pollInterval);
    return () => clearInterval(interval);
  }, [enabled, pollInterval, fetchTasks]);

  // Get tasks grouped by lane
  const backlogTasks = getTasksByLane(tasks, 'backlog');
  const inProgressTasks = getTasksByLane(tasks, 'in_progress');
  const reviewTasks = getTasksByLane(tasks, 'review');
  const doneTasks = getTasksByLane(tasks, 'done');

  const handleMoveTask = useCallback(async (taskId: number, newLane: KanbanLane) => {
    return moveTask(taskId, newLane);
  }, [moveTask]);

  const handleCreateTask = useCallback(async (
    title: string,
    description: string,
    priority: KanbanPriority,
    assignedAgentId?: number
  ) => {
    return createTask({
      title,
      description,
      lane: 'backlog',
      priority,
      assigned_agent_id: assignedAgentId,
    });
  }, [createTask]);

  const taskCounts = {
    backlog: backlogTasks.length,
    inProgress: inProgressTasks.length,
    review: reviewTasks.length,
    done: doneTasks.length,
    total: tasks.length,
  };

  return {
    tasks,
    selectedTask,
    isCreatingTask,
    loading,
    error,
    backlogTasks,
    inProgressTasks,
    reviewTasks,
    doneTasks,
    taskCounts,
    selectTask: setSelectedTask,
    setCreatingTask,
    moveTask: handleMoveTask,
    createTask: handleCreateTask,
    refresh: fetchTasks,
  };
}
