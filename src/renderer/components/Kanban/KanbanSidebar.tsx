import { useKanban } from '../../hooks/useKanban';
import { KanbanLane } from '@shared/types';
import KanbanColumn from './KanbanColumn';
import CreateTaskModal from './CreateTaskModal';
import TaskDetail from './TaskDetail';
import { LayoutList, Plus, RefreshCw, Loader2 } from 'lucide-react';

interface KanbanSidebarProps {
  isOpen: boolean;
  onClose?: () => void;
  agents: { id: string; name: string }[];
}

export default function KanbanSidebar({ isOpen, agents }: KanbanSidebarProps) {
  const {
    boards,
    selectedBoard,
    selectedTask,
    isCreatingTask,
    loading,
    backlogTasks,
    readyTasks,
    inProgressTasks,
    reviewTasks,
    doneTasks,
    taskCounts,
    selectBoard,
    selectTask,
    setCreatingTask,
    moveTask,
    createTask,
    updateTask,
    deleteTask,
    refresh
  } = useKanban({ enabled: isOpen });

  if (!isOpen) return null;

  const handleDrop = async (taskId: number, newLane: KanbanLane) => {
    await moveTask(taskId, newLane);
  };

  return (
    <div className="w-80 bg-[#0a1929] border-r border-[#2d4a6b] flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between p-3 border-b border-[#2d4a6b]">
        <div className="flex items-center gap-2">
          <LayoutList className="h-5 w-5 text-blue-400" />
          <span className="font-semibold text-white">Kanban</span>
          <span className="text-xs text-gray-500">({taskCounts.total})</span>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={refresh}
            disabled={loading}
            className="p-1.5 hover:bg-[#2d4a6b] rounded transition-colors"
            title="Refresh"
          >
            {loading ? (
              <Loader2 className="h-4 w-4 text-gray-400 animate-spin" />
            ) : (
              <RefreshCw className="h-4 w-4 text-gray-400" />
            )}
          </button>
          <button
            onClick={() => setCreatingTask(true)}
            className="p-1.5 hover:bg-[#2d4a6b] rounded transition-colors"
            title="New Task"
          >
            <Plus className="h-4 w-4 text-gray-400" />
          </button>
        </div>
      </div>

      {/* Board Selector */}
      {boards.length > 1 && (
        <div className="p-2 border-b border-[#2d4a6b]">
          <select
            value={selectedBoard?.id || ''}
            onChange={(e) => {
              const board = boards.find((b) => b.id === parseInt(e.target.value, 10));
              if (board) selectBoard(board);
            }}
            className="w-full px-2 py-1.5 bg-[#0d2137] border border-[#2d4a6b] rounded text-sm text-white focus:outline-none focus:border-blue-500"
          >
            {boards.map((board) => (
              <option key={board.id} value={board.id}>
                {board.name}
              </option>
            ))}
          </select>
        </div>
      )}

      {/* Columns */}
      <div className="flex-1 overflow-y-auto p-2 space-y-1">
        {selectedTask ? (
          <TaskDetail
            task={selectedTask}
            onClose={() => selectTask(null)}
            onUpdate={updateTask}
            onDelete={deleteTask}
            agents={agents}
          />
        ) : (
          <>
            <KanbanColumn
              lane="backlog"
              tasks={backlogTasks}
              count={taskCounts.backlog}
              onTaskClick={selectTask}
              onDrop={handleDrop}
            />
            <KanbanColumn
              lane="ready"
              tasks={readyTasks}
              count={taskCounts.ready}
              onTaskClick={selectTask}
              onDrop={handleDrop}
            />
            <KanbanColumn
              lane="in_progress"
              tasks={inProgressTasks}
              count={taskCounts.inProgress}
              onTaskClick={selectTask}
              onDrop={handleDrop}
            />
            <KanbanColumn
              lane="review"
              tasks={reviewTasks}
              count={taskCounts.review}
              onTaskClick={selectTask}
              onDrop={handleDrop}
            />
            <KanbanColumn
              lane="done"
              tasks={doneTasks}
              count={taskCounts.done}
              onTaskClick={selectTask}
              onDrop={handleDrop}
              collapsed={doneTasks.length > 5}
            />
          </>
        )}
      </div>

      {/* Empty State */}
      {!loading && taskCounts.total === 0 && !selectedTask && (
        <div className="flex-1 flex flex-col items-center justify-center p-4 text-center">
          <LayoutList className="h-12 w-12 text-gray-600 mb-3" />
          <p className="text-gray-400 text-sm mb-3">No tasks yet</p>
          <button
            onClick={() => setCreatingTask(true)}
            className="flex items-center gap-2 px-3 py-2 text-sm bg-blue-600 hover:bg-blue-700 text-white rounded-lg transition-colors"
          >
            <Plus className="h-4 w-4" />
            Add First Task
          </button>
        </div>
      )}

      {/* Create Task Modal */}
      <CreateTaskModal
        isOpen={isCreatingTask}
        onClose={() => setCreatingTask(false)}
        onCreate={createTask}
        agents={agents}
      />
    </div>
  );
}
