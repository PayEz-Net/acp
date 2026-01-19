import { useEffect, useCallback } from 'react';
import { useKanbanStore, getTasksByLane } from '../stores/kanbanStore';
import { KanbanLane, KanbanTask, KanbanPriority } from '@shared/types';

interface UseKanbanOptions {
  pollInterval?: number;
  enabled?: boolean;
}

export function useKanban({ pollInterval = 60000, enabled = true }: UseKanbanOptions = {}) {
  const {
    boards,
    tasks,
    selectedBoard,
    selectedTask,
    isCreatingTask,
    loading,
    error,
    setSelectedBoard,
    setSelectedTask,
    setCreatingTask,
    fetchBoards,
    fetchTasks,
    createTask,
    updateTask,
    moveTask,
    deleteTask
  } = useKanbanStore();

  // Initial fetch and polling
  useEffect(() => {
    if (!enabled) return;

    // Initial fetch
    fetchBoards();

    // Set up polling
    const interval = setInterval(() => {
      if (selectedBoard) {
        fetchTasks(selectedBoard.id);
      }
    }, pollInterval);

    return () => clearInterval(interval);
  }, [enabled, pollInterval, fetchBoards, fetchTasks, selectedBoard?.id]);

  // Get tasks grouped by lane (5 lanes)
  const backlogTasks = getTasksByLane(tasks, 'backlog');
  const readyTasks = getTasksByLane(tasks, 'ready');
  const inProgressTasks = getTasksByLane(tasks, 'in_progress');
  const reviewTasks = getTasksByLane(tasks, 'review');
  const doneTasks = getTasksByLane(tasks, 'done');

  // Handle task selection
  const handleSelectTask = useCallback((task: KanbanTask | null) => {
    setSelectedTask(task);
  }, [setSelectedTask]);

  // Handle board selection
  const handleSelectBoard = useCallback((board: typeof selectedBoard) => {
    setSelectedBoard(board);
    if (board) {
      fetchTasks(board.id);
    }
  }, [setSelectedBoard, fetchTasks]);

  // Handle task move (drag and drop)
  const handleMoveTask = useCallback(async (taskId: number, newLane: KanbanLane) => {
    return moveTask(taskId, newLane);
  }, [moveTask]);

  // Handle create task
  const handleCreateTask = useCallback(async (
    title: string,
    description: string,
    priority: KanbanPriority,
    assignedAgentId?: number
  ) => {
    if (!selectedBoard) return false;

    return createTask({
      board_id: selectedBoard.id,
      title,
      description,
      lane: 'backlog',
      priority,
      assigned_agent_id: assignedAgentId
    });
  }, [selectedBoard, createTask]);

  // Refresh manually
  const refresh = useCallback(() => {
    fetchBoards();
    if (selectedBoard) {
      fetchTasks(selectedBoard.id);
    }
  }, [fetchBoards, fetchTasks, selectedBoard]);

  // Task counts
  const taskCounts = {
    backlog: backlogTasks.length,
    ready: readyTasks.length,
    inProgress: inProgressTasks.length,
    review: reviewTasks.length,
    done: doneTasks.length,
    total: tasks.length
  };

  return {
    // State
    boards,
    tasks,
    selectedBoard,
    selectedTask,
    isCreatingTask,
    loading,
    error,

    // Grouped tasks (5 lanes)
    backlogTasks,
    readyTasks,
    inProgressTasks,
    reviewTasks,
    doneTasks,
    taskCounts,

    // Actions
    selectBoard: handleSelectBoard,
    selectTask: handleSelectTask,
    setCreatingTask,
    moveTask: handleMoveTask,
    createTask: handleCreateTask,
    updateTask,
    deleteTask,
    refresh
  };
}
