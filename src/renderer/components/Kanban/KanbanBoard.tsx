import { useEffect, useState } from 'react';
import { useKanbanStore, getTasksByLane, getPriorityColor } from '../../stores/kanbanStore';
import { useAppStore } from '../../stores/appStore';
import { OverlayPanel } from '../Layout/OverlayPanel';
import { KanbanLane, KanbanTask, KanbanPriority } from '@shared/types';
import { X, Plus, GripVertical, User, RefreshCw, Archive, ArchiveRestore, ArrowLeft, Loader2 } from 'lucide-react';
import TaskDetail from './TaskDetail';

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

// Return-column label for the Archived view (where a restored card lands). Falls
// back to the raw lane string only for display — restore itself writes no lane.
const LANE_LABELS: Record<string, string> = {
  backlog: 'Backlog',
  ready: 'Ready',
  in_progress: 'In Progress',
  review: 'Review',
  done: 'Done',
};

function useAgentName(agentId?: number): string | undefined {
  const agents = useAppStore((s) => s.agents);
  if (!agentId) return undefined;
  const agent = agents.find((a) => a.id === String(agentId));
  return agent?.displayName || agent?.name;
}

function TaskCard({ task, onSelect, onDragStart }: { task: KanbanTask; onSelect: () => void; onDragStart: (e: React.DragEvent) => void }) {
  const assigneeName = useAgentName(task.assigned_agent_id);
  const creatorName = useAgentName(task.created_by_agent_id);
  const ownerLabel = assigneeName || creatorName;

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
          <div className="text-sm text-slate-200 font-medium line-clamp-2" title={task.title}>{task.title}</div>
          <div className="flex items-center gap-2 mt-1 flex-wrap">
            <span className={`text-xs px-1.5 py-0.5 rounded border ${getPriorityColor(task.priority)}`}>
              {task.priority}
            </span>
            {ownerLabel && (
              <span className="flex items-center gap-1 text-xs text-slate-400">
                <User className="w-3 h-3" />
                {ownerLabel}
              </span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

export function KanbanBoard({ isOpen, onClose }: KanbanBoardProps) {
  const {
    tasks, archivedTasks, selectedTask, isCreatingTask, loading,
    fetchTasks, fetchArchived, moveTask, createTask, unarchiveTask,
    setSelectedTask, setCreatingTask,
  } = useKanbanStore();
  const { backendAvailable, agents } = useAppStore();
  const [dragTaskId, setDragTaskId] = useState<number | null>(null);
  // #153-A: the recovery surface is a board-level view (Aurum 2760 guardrail #1 —
  // reachable in ONE move from the board, never buried inside a card's detail).
  const [showArchived, setShowArchived] = useState(false);
  const [restoringId, setRestoringId] = useState<number | null>(null);

  // Create task form state
  const [newTitle, setNewTitle] = useState('');
  const [newPriority, setNewPriority] = useState<KanbanPriority>('medium');

  useEffect(() => {
    if (!isOpen || !backendAvailable) return;
    const refresh = () => { fetchTasks(); fetchArchived(); };
    refresh();
    const interval = setInterval(refresh, 10000);
    return () => clearInterval(interval);
  }, [isOpen, backendAvailable, fetchTasks, fetchArchived]);

  if (!isOpen) return null;

  // Agents for the task detail (id + a human name).
  const detailAgents = agents.map((a) => ({ id: a.id, name: a.displayName || a.name }));

  const handleRestore = async (taskId: number) => {
    // Asymmetric friction (Aurum 2747): restore is ONE click, NO confirm.
    setRestoringId(taskId);
    await unarchiveTask(taskId);
    setRestoringId(null);
  };

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
    setNewPriority('medium');
  };

  return (
    <OverlayPanel isOpen={isOpen} onClose={onClose} width="w-[600px]" className="bg-slate-900 border-slate-700">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-slate-700">
        <span className="text-sm font-semibold text-slate-200">Kanban Board</span>
        <div className="flex items-center gap-2">
          {/* #153-A entry point: shown ONLY when there are archived cards (render-real-
              or-nothing). One click into the board-level Archived view. */}
          {archivedTasks.length > 0 && !selectedTask && (
            <button
              onClick={() => { setSelectedTask(null); setShowArchived((v) => !v); }}
              className={`flex items-center gap-1.5 px-2 py-1 text-xs rounded-md transition-colors ${
                showArchived
                  ? 'bg-slate-700 text-slate-200'
                  : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800'
              }`}
              title="View archived tasks"
            >
              <Archive className="w-3.5 h-3.5" />
              Archived ({archivedTasks.length})
            </button>
          )}
          <button onClick={() => { fetchTasks(); fetchArchived(); }} disabled={loading} className="text-slate-400 hover:text-blue-400 transition-colors disabled:opacity-50" title="Refresh">
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          </button>
          <button onClick={() => setCreatingTask(true)} className="text-slate-400 hover:text-emerald-400 transition-colors" title="New Task">
            <Plus className="w-4 h-4" />
          </button>
          <button onClick={onClose} className="text-slate-400 hover:text-white"><X className="w-4 h-4" /></button>
        </div>
      </div>

      {!backendAvailable ? (
        <div className="p-4 text-sm text-slate-500 text-center">Backend required for kanban</div>
      ) : selectedTask ? (
        /* Task detail — the live board mounts it here so the Archive action is
           reachable from the seat (Aurum 2760 guardrail #3). */
        <TaskDetail task={selectedTask} onClose={() => setSelectedTask(null)} agents={detailAgents} />
      ) : showArchived ? (
        /* #153-A Archived view — a flat, out-of-flow list (NOT interleaved into the
           live columns). Each row: title + return column + Restore (one click). */
        <div className="flex-1 overflow-y-auto">
          <div className="flex items-center gap-2 px-4 py-2 border-b border-slate-800">
            <button onClick={() => setShowArchived(false)} className="flex items-center gap-1 text-xs text-slate-400 hover:text-slate-200" title="Back to board">
              <ArrowLeft className="w-3.5 h-3.5" /> Board
            </button>
            <span className="text-xs font-semibold text-slate-300 uppercase tracking-wide">Archived</span>
          </div>
          {archivedTasks.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-center">
              <Archive className="w-8 h-8 text-slate-700 mb-2" />
              <p className="text-sm text-slate-500">Nothing archived</p>
            </div>
          ) : (
            <div className="p-3 space-y-2">
              {archivedTasks.map((task) => (
                <div key={task.id} className="flex items-start gap-2 bg-slate-800/60 border border-slate-700 rounded-lg p-3">
                  <div className="min-w-0 flex-1">
                    <div className="text-sm text-slate-200 font-medium break-words" title={task.title}>{task.title}</div>
                    <div className="text-xs text-slate-500 mt-1">
                      Returns to <span className="text-slate-300">{LANE_LABELS[task.lane] ?? task.lane}</span>
                      {task.updated_at && <> · archived {new Date(task.updated_at).toLocaleDateString()}</>}
                    </div>
                  </div>
                  <button
                    onClick={() => handleRestore(task.id)}
                    disabled={restoringId === task.id}
                    className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs rounded-md bg-emerald-600/20 text-emerald-300 hover:bg-emerald-600/40 transition-colors disabled:opacity-50 shrink-0"
                    title="Restore this task to its column"
                  >
                    {restoringId === task.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ArchiveRestore className="w-3.5 h-3.5" />}
                    Restore
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
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
                  <option value="low">Low</option>
                  <option value="medium">Medium</option>
                  <option value="high">High</option>
                  <option value="critical">Critical</option>
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
    </OverlayPanel>
  );
}
