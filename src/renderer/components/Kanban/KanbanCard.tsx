import { KanbanTask } from '@shared/types';
import { getPriorityColor } from '../../stores/kanbanStore';
import { GripVertical, User } from 'lucide-react';

interface KanbanCardProps {
  task: KanbanTask;
  onClick: () => void;
  onDragStart: (e: React.DragEvent) => void;
  isDragging?: boolean;
}

export default function KanbanCard({ task, onClick, onDragStart, isDragging }: KanbanCardProps) {
  const priorityClass = getPriorityColor(task.priority);

  return (
    <div
      draggable
      onDragStart={onDragStart}
      onClick={onClick}
      className={`
        group bg-[#0d2137] border border-[#2d4a6b] rounded-lg p-2 cursor-pointer
        hover:border-blue-500/50 hover:bg-[#132a44] transition-colors
        ${isDragging ? 'opacity-50 border-blue-500' : ''}
      `}
    >
      <div className="flex items-start gap-2">
        <GripVertical className="h-4 w-4 text-gray-600 mt-0.5 opacity-0 group-hover:opacity-100 transition-opacity cursor-grab" />
        <div className="flex-1 min-w-0">
          <p className="text-sm text-white font-medium truncate">{task.title}</p>
          <div className="flex items-center gap-2 mt-1">
            <span className={`text-xs px-1.5 py-0.5 rounded border ${priorityClass}`}>
              {task.priority}
            </span>
            {task.assigned_agent_name && (
              <span className="flex items-center gap-1 text-xs text-gray-400">
                <User className="h-3 w-3" />
                {task.assigned_agent_name}
              </span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
