import { useState } from 'react';
import { KanbanPriority } from '@shared/types';
import { X, Plus, Loader2 } from 'lucide-react';

interface CreateTaskModalProps {
  isOpen: boolean;
  onClose: () => void;
  onCreate: (title: string, description: string, priority: KanbanPriority, assignedAgentId?: string) => Promise<boolean>;
  agents: { id: string; name: string }[];
}

export default function CreateTaskModal({ isOpen, onClose, onCreate, agents }: CreateTaskModalProps) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [priority, setPriority] = useState<KanbanPriority>('medium');
  const [assignedAgent, setAssignedAgent] = useState('');
  const [isSending, setIsSending] = useState(false);

  if (!isOpen) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;

    setIsSending(true);
    const success = await onCreate(
      title.trim(),
      description.trim(),
      priority,
      assignedAgent || undefined
    );

    if (success) {
      setTitle('');
      setDescription('');
      setPriority('medium');
      setAssignedAgent('');
      onClose();
    }
    setIsSending(false);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      onClose();
    }
  };

  return (
    <div
      className="fixed inset-0 bg-black/50 flex items-center justify-center z-50"
      onClick={(e) => e.target === e.currentTarget && onClose()}
      onKeyDown={handleKeyDown}
    >
      <div className="bg-[#132a44] border border-[#2d4a6b] rounded-xl w-full max-w-md shadow-xl">
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-[#2d4a6b]">
          <h2 className="text-lg font-semibold text-white">New Task</h2>
          <button
            onClick={onClose}
            className="p-1 hover:bg-[#2d4a6b] rounded transition-colors"
          >
            <X className="h-5 w-5 text-gray-400" />
          </button>
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit} className="p-4 space-y-4">
          {/* Title */}
          <div>
            <label className="block text-sm font-medium text-gray-300 mb-1">
              Title *
            </label>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Task title"
              autoFocus
              className="w-full px-3 py-2 bg-[#0d2137] border border-[#2d4a6b] rounded-lg text-white placeholder-gray-500 focus:outline-none focus:border-blue-500"
            />
          </div>

          {/* Description */}
          <div>
            <label className="block text-sm font-medium text-gray-300 mb-1">
              Description
            </label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Optional description"
              rows={3}
              className="w-full px-3 py-2 bg-[#0d2137] border border-[#2d4a6b] rounded-lg text-white placeholder-gray-500 focus:outline-none focus:border-blue-500 resize-none"
            />
          </div>

          {/* Priority */}
          <div>
            <label className="block text-sm font-medium text-gray-300 mb-1">
              Priority
            </label>
            <select
              value={priority}
              onChange={(e) => setPriority(e.target.value as KanbanPriority)}
              className="w-full px-3 py-2 bg-[#0d2137] border border-[#2d4a6b] rounded-lg text-white focus:outline-none focus:border-blue-500"
            >
              <option value="low">Low</option>
              <option value="medium">Medium</option>
              <option value="high">High</option>
              <option value="urgent">Urgent</option>
            </select>
          </div>

          {/* Assign to Agent */}
          <div>
            <label className="block text-sm font-medium text-gray-300 mb-1">
              Assign to
            </label>
            <select
              value={assignedAgent}
              onChange={(e) => setAssignedAgent(e.target.value)}
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

          {/* Actions */}
          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-sm text-gray-300 hover:bg-[#2d4a6b] rounded-lg transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={!title.trim() || isSending}
              className="flex items-center gap-2 px-4 py-2 text-sm bg-blue-600 hover:bg-blue-700 text-white rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {isSending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Plus className="h-4 w-4" />
              )}
              Create Task
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
