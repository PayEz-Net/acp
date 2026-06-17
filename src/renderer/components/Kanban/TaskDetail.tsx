import { useState } from 'react';
import { KanbanTask, KanbanLane } from '@shared/types';
import { getPriorityColor, useKanbanStore } from '../../stores/kanbanStore';
import { X, User, Calendar, Archive, Loader2 } from 'lucide-react';

interface TaskDetailProps {
  task: KanbanTask;
  onClose: () => void;
  agents: { id: string; name: string }[];
}

const LANE_LABELS: Record<KanbanLane, string> = {
  backlog: 'Backlog',
  ready: 'Ready',
  in_progress: 'In Progress',
  review: 'Review',
  done: 'Done',
};

// The desktop kanban is read-only by design (#47 D1): observe here, edit on the
// web dashboard. Persisting field-edits/delete needs backend endpoints (#64), so
// this view honestly SHOWS the task rather than offering Save/Delete that no
// parent wires up and the API can't persist (#95). Lane/assignee changes happen
// by drag (status) on the board.
export default function TaskDetail({ task, onClose, agents }: TaskDetailProps) {
  const archiveTask = useKanbanStore((s) => s.archiveTask);
  // #153-A light-confirm: a click arms the confirm inline (no native dialog / heavy
  // modal); a second click commits. Archive is a RECOVERABLE soft-delete, so the
  // confirm is light, not a scary delete warning — and it NAMES the restore path
  // (Aurum 2747 §4: recoverability is promised at the moment of removal).
  const [confirming, setConfirming] = useState(false);
  const [archiving, setArchiving] = useState(false);

  const handleArchive = async () => {
    if (!confirming) {
      setConfirming(true);
      return;
    }
    setArchiving(true);
    const ok = await archiveTask(task.id);
    setArchiving(false);
    if (ok) onClose(); // task drops off the board (GET /tasks excludes archived)
    else setConfirming(false);
  };

  const assigneeName =
    (task.assigned_agent_id != null
      ? agents.find((a) => a.id === String(task.assigned_agent_id))?.name
      : undefined) ||
    // acp-api returns the assignee as a name string; surface it when present.
    (task as unknown as { assignedTo?: string }).assignedTo;

  return (
    <div className="bg-[#132a44] border-l border-[#2d4a6b] h-full flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between p-4 border-b border-[#2d4a6b]">
        <h2 className="text-lg font-semibold text-white truncate">Task Details</h2>
        <button
          onClick={onClose}
          className="p-1 hover:bg-[#2d4a6b] rounded transition-colors"
        >
          <X className="h-5 w-5 text-gray-400" />
        </button>
      </div>

      {/* Content (read-only) */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {/* Title */}
        <div>
          <label className="block text-xs uppercase tracking-wide text-gray-500 mb-1">Title</label>
          <p className="text-white font-medium break-words">{task.title}</p>
        </div>

        {/* Description */}
        <div>
          <label className="block text-xs uppercase tracking-wide text-gray-500 mb-1">Description</label>
          {task.description ? (
            <p className="text-sm text-gray-300 whitespace-pre-wrap break-words">{task.description}</p>
          ) : (
            <p className="text-sm text-gray-600 italic">No description</p>
          )}
        </div>

        {/* Lane (Status) + Priority */}
        <div className="flex gap-6">
          <div>
            <label className="block text-xs uppercase tracking-wide text-gray-500 mb-1">Lane</label>
            <p className="text-sm text-gray-200">{LANE_LABELS[task.lane] ?? task.lane}</p>
          </div>
          <div>
            <label className="block text-xs uppercase tracking-wide text-gray-500 mb-1">Priority</label>
            <span className={`text-xs px-1.5 py-0.5 rounded border ${getPriorityColor(task.priority)}`}>
              {task.priority}
            </span>
          </div>
        </div>

        {/* Assignee */}
        <div>
          <label className="block text-xs uppercase tracking-wide text-gray-500 mb-1">Assigned to</label>
          {assigneeName ? (
            <p className="flex items-center gap-1.5 text-sm text-gray-200">
              <User className="h-4 w-4" />
              {assigneeName}
            </p>
          ) : (
            <p className="text-sm text-gray-600 italic">Unassigned</p>
          )}
        </div>

        {/* Metadata */}
        <div className="pt-4 border-t border-[#2d4a6b] space-y-2">
          <div className="flex items-center gap-2 text-sm text-gray-400">
            <Calendar className="h-4 w-4" />
            Created: {new Date(task.created_at).toLocaleString()}
          </div>
          {task.updated_at && (
            <div className="flex items-center gap-2 text-sm text-gray-400">
              <Calendar className="h-4 w-4" />
              Updated: {new Date(task.updated_at).toLocaleString()}
            </div>
          )}
        </div>
      </div>

      {/* Footer — Archive (recoverable soft-delete, #153-A) + Close */}
      <div className="border-t border-[#2d4a6b]">
        {/* Honesty copy (Aurum 2747 §4): recoverability is promised AT the moment of
            removal and backed by the board-level Archived view the user can reach. */}
        {confirming && !archiving && (
          <p className="px-4 pt-3 text-xs text-amber-200/80">
            Archive this task? You can restore it anytime from <span className="font-medium">Archived</span>.
          </p>
        )}
        <div className="flex items-center justify-between gap-2 p-4">
          <button
            onClick={handleArchive}
            disabled={archiving}
            className={`flex items-center gap-1.5 px-3 py-2 text-sm rounded-lg transition-colors disabled:opacity-50 ${
              confirming
                ? 'bg-amber-600/30 text-amber-200 hover:bg-amber-600/50'
                : 'text-gray-400 hover:text-amber-300 hover:bg-[#2d4a6b]'
            }`}
            title="Archive this task (recoverable — removes it from the board, not deleted)"
          >
            {archiving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Archive className="w-4 h-4" />}
            {confirming ? 'Archive — confirm?' : 'Archive'}
          </button>
          <div className="flex items-center gap-2">
            {confirming && !archiving && (
              <button
                onClick={() => setConfirming(false)}
                className="px-3 py-2 text-sm text-gray-400 hover:bg-[#2d4a6b] rounded-lg transition-colors"
              >
                Cancel
              </button>
            )}
            <button
              onClick={onClose}
              className="px-4 py-2 text-sm text-gray-300 hover:bg-[#2d4a6b] rounded-lg transition-colors"
            >
              Close
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
