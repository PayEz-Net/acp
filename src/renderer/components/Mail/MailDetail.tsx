import { MailMessage } from '@shared/types';
import { X, Reply, Clock, User } from 'lucide-react';

interface MailDetailProps {
  message: MailMessage;
  onClose: () => void;
  onReply: () => void;
}

export function MailDetail({ message, onClose, onReply }: MailDetailProps) {
  const date = new Date(message.created_at);
  const formattedDate = date.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });

  return (
    <div className="flex flex-col h-full bg-slate-900">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-slate-700">
        <h3 className="text-sm font-semibold text-slate-200 truncate flex-1">
          {message.subject}
        </h3>
        <div className="flex items-center gap-1">
          <button
            onClick={onReply}
            className="p-1.5 text-slate-400 hover:text-violet-400 hover:bg-slate-800 rounded transition-colors"
            title="Reply"
          >
            <Reply className="w-4 h-4" />
          </button>
          <button
            onClick={onClose}
            className="p-1.5 text-slate-400 hover:text-slate-200 hover:bg-slate-800 rounded transition-colors"
            title="Close"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Meta */}
      <div className="px-4 py-3 border-b border-slate-800 space-y-2">
        <div className="flex items-center gap-2 text-sm">
          <User className="w-4 h-4 text-slate-500" />
          <span className="text-slate-400">From:</span>
          <span className="text-slate-200 font-medium">{message.from_agent}</span>
        </div>
        <div className="flex items-center gap-2 text-sm">
          <User className="w-4 h-4 text-slate-500" />
          <span className="text-slate-400">To:</span>
          <span className="text-slate-200">{message.to_agent}</span>
        </div>
        <div className="flex items-center gap-2 text-sm">
          <Clock className="w-4 h-4 text-slate-500" />
          <span className="text-slate-400">{formattedDate}</span>
        </div>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-auto p-4">
        <pre className="text-sm text-slate-300 whitespace-pre-wrap font-sans leading-relaxed">
          {message.body}
        </pre>
      </div>
    </div>
  );
}
