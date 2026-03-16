import { useEffect, useState } from 'react';
import { useKanbanStore, getTasksByLane, getPriorityColor } from '../../stores/kanbanStore';
import { useAppStore } from '../../stores/appStore';
import { KanbanLane, KanbanTask } from '@shared/types';
import { X, Plus, GripVertical } from 'lucide-react';

interface KanbanBoardProps {
  isOpen: boolean;
  onClose: () => void;
}

const LANES: { id: KanbanLane; label: string; color: string }[] = [
  { id: 'backlog', label: 'Backlog', color: 'border-slate-500' },
  { id: 'in_progress', label: 'In Progress', color: 'border-blue-500' },
  { id: 'review', label: 'Review', color: 'border-amber-500' },
  { id: 'done', label: 'Done', color: 'border-green-500' },
];

function TaskCard({ task, onSelect, onDragStart }: { task: KanbanTask; onSelect: () => void; onDragStart: (e: React.DragEvent) => void }) {
  return (
    <div
      draggable
      onDragStart={onDragStart}
      onClick={onSelect}
      className="bg-slate-800 rounded-lg p-3 cursor-pointer hover:bg-slate-750 border border-slate-700 hover:border-slate-600 transition-colors"
    >
      <div className="flex items-start gap-2">
        <GripVertical className="w-3 h-3 text-slate-600 mt-1 shrink-0 cursor-grab" />
        <div className="min-w-0 flex-1">
          <div className="text-sm text-slate-200 font-medium truncate">{task.title}</div>
          <div className="flex items-center gap-2 mt-1">
            <span className={`text-xs px-1.5 py-0.5 rounded border ${getPriorityColor(task.priority)}`}>
              {task.priority}
            </span>
            {task.assigned_agent_id && (
              <span className="text-xs text-slate-500">Agent #{task.assigned_agent_id}</span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

export function KanbanBoard({ isOpen, onClose }: KanbanBoardProps) {
  const { tasks, loading, isCreatingTask, fetchTasks, moveTask, createTask, setSelectedTask, setCreatingTask } = useKanbanStore();
  const { backendAvailable } = useAppStore();
  const [dragTaskId, setDragTaskId] = useState<number | null>(null);

  // Create task form state
  const [newTitle, setNewTitle] = useState('');
  const [newPriority, setNewPriority] = useState<'normal' | 'high' | 'urgent'>('normal');

  useEffect(() => {
    if (!isOpen || !backendAvailable) return;
    fetchTasks();
    const interval = setInterval(fetchTasks, 10000);
    return () => clearInterval(interval);
  }, [isOpen, backendAvailable, fetchTasks]);

  if (!isOpen) return null;

  const handleDrop = (e: React.DragEvent, lane: KanbanLane) => {
    e.preventDefault();
    if (dragTaskId !== null) {
      moveTask(dragTaskId, lane);
      setDragTaskId(null);
    }
  };

  const handleCreate = async () => {
    if (!newTitle.trim()) return;
    await createTask({ title: newTitle.trim(), priority: newPriority, lane: 'backlog' });
    setNewTitle('');
    setNewPriority('normal');
  };

  return (
    <div className="w-[600px] bg-slate-900 border-l border-slate-700 flex flex-col h-full overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-slate-700">
        <span className="text-sm font-semibold text-slate-200">Kanban Board</span>
        <div className="flex items-center gap-2">
          <button onClick={() => setCreatingTask(true)} className="text-slate-400 hover:text-emerald-400 transition-colors" title="New Task">
            <Plus className="w-4 h-4" />
          </button>
          <button onClick={onClose} className="text-slate-400 hover:text-white"><X className="w-4 h-4" /></button>
        </div>
      </div>

      {!backendAvailable ? (
        <div className="p-4 text-sm text-slate-500 text-center">Backend required for kanban</div>
      ) : (
        <div className="flex-1 overflow-x-auto">
          {/* Create Task Form */}
          {isCreatingTask && (
            <div className="p-3 border-b border-slate-800 bg-slate-850">
              <input
                type="text"
                value={newTitle}
                onChange={(e) => setNewTitle(e.target.value)}
                placeholder="Task title..."
                className="w-full px-3 py-2 bg-slate-800 border border-slate-600 rounded text-white text-sm placeholder-slate-500 focus:outline-none focus:border-vibe-500 mb-2"
                onKeyDown={(e) => e.key === 'Enter' && handleCreate()}
                autoFocus
              />
              <div className="flex gap-2">
                <select value={newPriority} onChange={(e) => setNewPriority(e.target.value as typeof newPriority)}
                  className="px-2 py-1 bg-slate-800 border border-slate-600 rounded text-xs text-slate-300">
                  <option value="normal">Normal</option>
                  <option value="high">High</option>
                  <option value="urgent">Urgent</option>
                </select>
                <button onClick={handleCreate} className="px-3 py-1 bg-emerald-600 text-white text-xs rounded hover:bg-emerald-500">Create</button>
                <button onClick={() => setCreatingTask(false)} className="px-3 py-1 text-slate-400 text-xs hover:text-white">Cancel</button>
              </div>
            </div>
          )}

          {/* Lanes */}
          <div className="flex gap-2 p-3 min-w-max">
            {LANES.map((lane) => {
              const laneTasks = getTasksByLane(tasks, lane.id);
              return (
                <div
                  key={lane.id}
                  className={`w-[140px] shrink-0 border-t-2 ${lane.color}`}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={(e) => handleDrop(e, lane.id)}
                >
                  <div className="flex items-center justify-between py-2">
                    <span className="text-xs font-semibold text-slate-400 uppercase">{lane.label}</span>
                    <span className="text-xs text-slate-500">{laneTasks.length}</span>
                  </div>
                  <div className="space-y-2">
                    {laneTasks.map((task) => (
                      <TaskCard
                        key={task.id}
                        task={task}
                        onSelect={() => setSelectedTask(task)}
                        onDragStart={(e) => {
                          setDragTaskId(task.id);
                          e.dataTransfer.effectAllowed = 'move';
                        }}
                      />
                    ))}
                    {laneTasks.length === 0 && (
                      <div className="text-xs text-slate-600 text-center py-4 border border-dashed border-slate-700 rounded">
                        Drop here
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
