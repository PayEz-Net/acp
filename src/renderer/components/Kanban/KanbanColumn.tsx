import { useState } from 'react';
import { KanbanTask, KanbanLane } from '@shared/types';
import KanbanCard from './KanbanCard';
import { ChevronDown, ChevronRight } from 'lucide-react';

interface KanbanColumnProps {
  lane: KanbanLane;
  tasks: KanbanTask[];
  count: number;
  onTaskClick: (task: KanbanTask) => void;
  onDrop: (taskId: number, newLane: KanbanLane) => void;
  collapsed?: boolean;
}

const laneColors: Record<KanbanLane, string> = {
  backlog: 'text-gray-400',
  ready: 'text-blue-400',
  in_progress: 'text-yellow-400',
  review: 'text-purple-400',
  done: 'text-green-400'
};

const laneLabels: Record<KanbanLane, string> = {
  backlog: 'Backlog',
  ready: 'Ready',
  in_progress: 'In Progress',
  review: 'Review',
  done: 'Done'
};

export default function KanbanColumn({
  lane,
  tasks,
  count,
  onTaskClick,
  onDrop,
  collapsed: initialCollapsed = false
}: KanbanColumnProps) {
  const [isCollapsed, setIsCollapsed] = useState(initialCollapsed);
  const [isDragOver, setIsDragOver] = useState(false);
  const [draggingTaskId, setDraggingTaskId] = useState<number | null>(null);

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(true);
  };

  const handleDragLeave = () => {
    setIsDragOver(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
    const taskId = parseInt(e.dataTransfer.getData('taskId'), 10);
    if (taskId) {
      onDrop(taskId, lane);
    }
  };

  const handleDragStart = (e: React.DragEvent, taskId: number) => {
    e.dataTransfer.setData('taskId', taskId.toString());
    setDraggingTaskId(taskId);
  };

  const handleDragEnd = () => {
    setDraggingTaskId(null);
  };

  return (
    <div
      className={`
        rounded-lg transition-colors
        ${isDragOver ? 'bg-blue-900/20 border-blue-500/50' : ''}
      `}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {/* Column Header */}
      <button
        onClick={() => setIsCollapsed(!isCollapsed)}
        className="w-full flex items-center gap-2 py-2 px-1 hover:bg-[#1a3a5c] rounded transition-colors"
      >
        {isCollapsed ? (
          <ChevronRight className="h-4 w-4 text-gray-400" />
        ) : (
          <ChevronDown className="h-4 w-4 text-gray-400" />
        )}
        <span className={`text-sm font-medium ${laneColors[lane]}`}>
          {laneLabels[lane]}
        </span>
        <span className="text-xs text-gray-500">({count})</span>
      </button>

      {/* Tasks */}
      {!isCollapsed && (
        <div className="space-y-2 pl-6 pr-1 pb-2" onDragEnd={handleDragEnd}>
          {tasks.map((task) => (
            <KanbanCard
              key={task.id}
              task={task}
              onClick={() => onTaskClick(task)}
              onDragStart={(e) => handleDragStart(e, task.id)}
              isDragging={draggingTaskId === task.id}
            />
          ))}
          {tasks.length === 0 && (
            <p className="text-xs text-gray-500 italic py-2">No tasks</p>
          )}
        </div>
      )}
    </div>
  );
}
