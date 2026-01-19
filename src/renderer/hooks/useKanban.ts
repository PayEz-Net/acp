import { useEffect, useCallback } from 'react';
import { useKanbanStore, getTasksByStatus } from '../stores/kanbanStore';
import { KanbanStatus, KanbanTask, KanbanPriority } from '@shared/types';

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
        fetchTasks(selectedBoard.board_id);
      }
    }, pollInterval);

    return () => clearInterval(interval);
  }, [enabled, pollInterval, fetchBoards, fetchTasks, selectedBoard?.board_id]);

  // Get tasks grouped by status
  const todoTasks = getTasksByStatus(tasks, 'TODO');
  const inProgressTasks = getTasksByStatus(tasks, 'IN_PROGRESS');
  const doneTasks = getTasksByStatus(tasks, 'DONE');

  // Handle task selection
  const handleSelectTask = useCallback((task: KanbanTask | null) => {
    setSelectedTask(task);
  }, [setSelectedTask]);

  // Handle board selection
  const handleSelectBoard = useCallback((board: typeof selectedBoard) => {
    setSelectedBoard(board);
    if (board) {
      fetchTasks(board.board_id);
    }
  }, [setSelectedBoard, fetchTasks]);

  // Handle task move (drag and drop)
  const handleMoveTask = useCallback(async (taskId: number, newStatus: KanbanStatus) => {
    return moveTask(taskId, newStatus);
  }, [moveTask]);

  // Handle create task
  const handleCreateTask = useCallback(async (
    title: string,
    description: string,
    priority: KanbanPriority,
    assignedAgentId?: string
  ) => {
    if (!selectedBoard) return false;

    return createTask({
      board_id: selectedBoard.board_id,
      title,
      description,
      status: 'TODO',
      priority,
      assigned_agent_id: assignedAgentId
    });
  }, [selectedBoard, createTask]);

  // Refresh manually
  const refresh = useCallback(() => {
    fetchBoards();
    if (selectedBoard) {
      fetchTasks(selectedBoard.board_id);
    }
  }, [fetchBoards, fetchTasks, selectedBoard]);

  // Task counts
  const taskCounts = {
    todo: todoTasks.length,
    inProgress: inProgressTasks.length,
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

    // Grouped tasks
    todoTasks,
    inProgressTasks,
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
