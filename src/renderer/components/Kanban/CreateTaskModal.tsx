import { useRef, useState } from 'react';
import { KanbanPriority } from '@shared/types';
import { X, Plus, Loader2 } from 'lucide-react';

interface CreateTaskModalProps {
  isOpen: boolean;
  onClose: () => void;
  onCreate: (title: string, description: string, priority: KanbanPriority, assignedAgentName?: string) => Promise<boolean>;
  agents: { id: string; name: string }[];
}

export default function CreateTaskModal({ isOpen, onClose, onCreate, agents }: CreateTaskModalProps) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [priority, setPriority] = useState<KanbanPriority>('medium');
  const [assignedAgent, setAssignedAgent] = useState('');
  const [isSending, setIsSending] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  // Single-fire (Aurum UX spec — same fire-once discipline as regenerate): a synchronous ref
  // guarantees exactly-one create per submit regardless of double-click / render timing.
  const submitInFlightRef = useRef(false);

  if (!isOpen) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;
    if (submitInFlightRef.current) return;
    submitInFlightRef.current = true;

    setIsSending(true);
    setErrorMsg(null);
    try {
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
      } else {
        // No silent failure on submit (Aurum spec): keep the user's typed input intact,
        // surface an honest error, never close-and-lose.
        setErrorMsg("Couldn't save the task. Your input is kept — check your connection and try again.");
      }
    } finally {
      setIsSending(false);
      submitInFlightRef.current = false;
    }
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
            <label className="block text-sm font-normal text-gray-300 mb-1">
              Title *
            </label>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="What needs doing?"
              autoFocus
              className="w-full px-3 py-3 text-base bg-[#0d2137] border border-[#2d4a6b] rounded-lg text-white placeholder-gray-500 focus:outline-none focus:border-blue-500"
            />
          </div>

          {/* Description */}
          <div>
            <label className="block text-sm font-normal text-gray-300 mb-1">
              Description
            </label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Context, acceptance criteria, links. Agents act on this — be specific."
              rows={5}
              className="w-full px-3 py-2 min-h-[7rem] bg-[#0d2137] border border-[#2d4a6b] rounded-lg text-white placeholder-gray-500 focus:outline-none focus:border-blue-500 resize-y"
            />
          </div>

          {/* Priority */}
          <div>
            <label className="block text-sm font-normal text-gray-300 mb-1">
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
              <option value="critical">Critical</option>
            </select>
          </div>

          {/* Assign to Agent */}
          <div>
            <label className="block text-sm font-normal text-gray-300 mb-1">
              Assign to
            </label>
            <select
              value={assignedAgent}
              onChange={(e) => setAssignedAgent(e.target.value)}
              className="w-full px-3 py-2 bg-[#0d2137] border border-[#2d4a6b] rounded-lg text-white focus:outline-none focus:border-blue-500"
            >
              <option value="">Unassigned</option>
              {agents.map((agent) => (
                <option key={agent.id} value={agent.name}>
                  {agent.name}
                </option>
              ))}
            </select>
          </div>

          {/* Inline error — never close-and-lose; input preserved (Aurum spec) */}
          {errorMsg && (
            <div className="px-3 py-2 rounded-lg bg-red-900/30 border border-red-500/40 text-sm text-red-300">
              {errorMsg}
            </div>
          )}

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
