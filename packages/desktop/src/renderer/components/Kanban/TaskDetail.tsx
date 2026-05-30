import { useState } from 'react';
import { KanbanTask, KanbanLane, KanbanPriority } from '@shared/types';
import { X, Trash2, User, Calendar, Loader2 } from 'lucide-react';

interface TaskDetailProps {
  task: KanbanTask;
  onClose: () => void;
  onUpdate?: (taskId: number, updates: Partial<KanbanTask>) => Promise<boolean>;
  onDelete?: (taskId: number) => Promise<boolean>;
  agents: { id: string; name: string }[];
}

export default function TaskDetail({ task, onClose, onUpdate, onDelete, agents }: TaskDetailProps) {
  const [isDeleting, setIsDeleting] = useState(false);
  const [isUpdating, setIsUpdating] = useState(false);
  const [editedTitle, setEditedTitle] = useState(task.title);
  const [editedDescription, setEditedDescription] = useState(task.description || '');
  const [editedPriority, setEditedPriority] = useState(task.priority);
  const [editedLane, setEditedLane] = useState(task.lane);
  const [editedAssignee, setEditedAssignee] = useState(task.assigned_agent_id?.toString() || '');

  const hasChanges =
    editedTitle !== task.title ||
    editedDescription !== (task.description || '') ||
    editedPriority !== task.priority ||
    editedLane !== task.lane ||
    editedAssignee !== (task.assigned_agent_id?.toString() || '');

  const handleSave = async () => {
    if (!editedTitle.trim()) return;

    setIsUpdating(true);
    await onUpdate?.(task.id, {
      title: editedTitle.trim(),
      description: editedDescription.trim() || undefined,
      priority: editedPriority,
      lane: editedLane,
      assigned_agent_id: editedAssignee ? parseInt(editedAssignee, 10) : undefined
    });
    setIsUpdating(false);
    onClose();
  };

  const handleDelete = async () => {
    if (!confirm('Delete this task?')) return;

    setIsDeleting(true);
    await onDelete?.(task.id);
    setIsDeleting(false);
  };

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

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {/* Title */}
        <div>
          <label className="block text-sm font-medium text-gray-300 mb-1">Title</label>
          <input
            type="text"
            value={editedTitle}
            onChange={(e) => setEditedTitle(e.target.value)}
            className="w-full px-3 py-2 bg-[#0d2137] border border-[#2d4a6b] rounded-lg text-white focus:outline-none focus:border-blue-500"
          />
        </div>

        {/* Description */}
        <div>
          <label className="block text-sm font-medium text-gray-300 mb-1">Description</label>
          <textarea
            value={editedDescription}
            onChange={(e) => setEditedDescription(e.target.value)}
            rows={4}
            className="w-full px-3 py-2 bg-[#0d2137] border border-[#2d4a6b] rounded-lg text-white focus:outline-none focus:border-blue-500 resize-none"
          />
        </div>

        {/* Lane (Status) */}
        <div>
          <label className="block text-sm font-medium text-gray-300 mb-1">Lane</label>
          <select
            value={editedLane}
            onChange={(e) => setEditedLane(e.target.value as KanbanLane)}
            className="w-full px-3 py-2 bg-[#0d2137] border border-[#2d4a6b] rounded-lg text-white focus:outline-none focus:border-blue-500"
          >
            <option value="backlog">Backlog</option>
            <option value="ready">Ready</option>
            <option value="in_progress">In Progress</option>
            <option value="review">Review</option>
            <option value="done">Done</option>
          </select>
        </div>

        {/* Priority */}
        <div>
          <label className="block text-sm font-medium text-gray-300 mb-1">Priority</label>
          <select
            value={editedPriority}
            onChange={(e) => setEditedPriority(e.target.value as KanbanPriority)}
            className="w-full px-3 py-2 bg-[#0d2137] border border-[#2d4a6b] rounded-lg text-white focus:outline-none focus:border-blue-500"
          >
            <option value="low">Low</option>
            <option value="normal">Normal</option>
            <option value="high">High</option>
            <option value="urgent">Urgent</option>
          </select>
        </div>

        {/* Assignee */}
        <div>
          <label className="block text-sm font-medium text-gray-300 mb-1">
            <User className="h-4 w-4 inline mr-1" />
            Assigned to
          </label>
          <select
            value={editedAssignee}
            onChange={(e) => setEditedAssignee(e.target.value)}
            className="w-full px-3 py-2 bg-[#0d2137] border border-[#2d4a6b] rounded-lg text-white focus:outline-none focus:border-blue-500"
          >
            <option value="">Unassigned</option>
            {agents.map((agent) => (
              <option key={agent.id} value={agent.id}>
                {agent.name}
              </option>
            ))}
          </select>
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

      {/* Footer */}
      <div className="flex items-center justify-between p-4 border-t border-[#2d4a6b]">
        <button
          onClick={handleDelete}
          disabled={isDeleting}
          className="flex items-center gap-2 px-3 py-2 text-sm text-red-400 hover:bg-red-900/30 rounded-lg transition-colors disabled:opacity-50"
        >
          {isDeleting ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Trash2 className="h-4 w-4" />
          )}
          Delete
        </button>
        <div className="flex gap-2">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm text-gray-300 hover:bg-[#2d4a6b] rounded-lg transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={!hasChanges || !editedTitle.trim() || isUpdating}
            className="flex items-center gap-2 px-4 py-2 text-sm bg-blue-600 hover:bg-blue-700 text-white rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isUpdating && <Loader2 className="h-4 w-4 animate-spin" />}
            Save Changes
          </button>
        </div>
      </div>
    </div>
  );
}
