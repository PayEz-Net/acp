import { MailMessage } from '@shared/types';
import { Mail, MailOpen } from 'lucide-react';

interface MailItemProps {
  message: MailMessage;
  isSelected: boolean;
  onClick: () => void;
}

export function MailItem({ message, isSelected, onClick }: MailItemProps) {
  const isUnread = !message.is_read;
  const timeAgo = formatTimeAgo(message.created_at);

  // Check if from BAPert (priority)
  const isPriority = message.from_agent === 'BAPert';

  return (
    <button
      onClick={onClick}
      className={`
        w-full text-left px-3 py-2 rounded-lg transition-colors
        ${isSelected
          ? 'bg-violet-600/30 border border-violet-500/50'
          : 'hover:bg-slate-700/50 border border-transparent'
        }
        ${isUnread ? 'bg-slate-800/80' : ''}
      `}
    >
      <div className="flex items-start gap-2">
        {/* Read/unread indicator */}
        <div className="pt-0.5">
          {isUnread ? (
            <Mail className={`w-4 h-4 ${isPriority ? 'text-amber-400' : 'text-violet-400'}`} />
          ) : (
            <MailOpen className="w-4 h-4 text-slate-500" />
          )}
        </div>

        <div className="flex-1 min-w-0">
          {/* From and time */}
          <div className="flex items-center justify-between gap-2">
            <span
              className={`text-xs truncate ${
                isUnread
                  ? isPriority
                    ? 'text-amber-400 font-semibold'
                    : 'text-slate-200 font-medium'
                  : 'text-slate-400'
              }`}
            >
              {message.from_agent}
            </span>
            <span className="text-xs text-slate-500 whitespace-nowrap">{timeAgo}</span>
          </div>

          {/* Subject */}
          <p
            className={`text-sm truncate mt-0.5 ${
              isUnread ? 'text-slate-200' : 'text-slate-400'
            }`}
          >
            {message.subject}
          </p>
        </div>
      </div>
    </button>
  );
}

function formatTimeAgo(dateStr: string): string {
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);

  if (diffMins < 1) return 'now';
  if (diffMins < 60) return `${diffMins}m`;

  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return `${diffHours}h`;

  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 7) return `${diffDays}d`;

  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}
