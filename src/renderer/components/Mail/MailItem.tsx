import { MailMessage } from '@shared/types';
import { Mail, MailOpen, AlertTriangle, Flag } from 'lucide-react';

interface MailItemProps {
  message: MailMessage;
  isSelected: boolean;
  onClick: () => void;
}

type Priority = 'high' | 'flagged' | 'normal';

function getMessagePriority(message: MailMessage): Priority {
  // From BAPert or TASK: prefix = high priority
  if (message.from_agent === 'BAPert' || message.subject.startsWith('TASK:')) {
    return 'high';
  }
  // CHANGES: prefix = flagged (needs attention)
  if (message.subject.startsWith('CHANGES:')) {
    return 'flagged';
  }
  return 'normal';
}

export function MailItem({ message, isSelected, onClick }: MailItemProps) {
  const isUnread = !message.is_read;
  const timeAgo = formatTimeAgo(message.created_at);
  const priority = getMessagePriority(message);
  const isPriority = priority === 'high';

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

          {/* Subject with priority badge */}
          <div className="flex items-center gap-1.5 mt-0.5">
            {priority === 'high' && (
              <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 text-[10px] font-bold bg-red-500/20 text-red-400 rounded">
                <AlertTriangle className="w-3 h-3" />
                HIGH
              </span>
            )}
            {priority === 'flagged' && (
              <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 text-[10px] font-bold bg-orange-500/20 text-orange-400 rounded">
                <Flag className="w-3 h-3" />
                CHANGES
              </span>
            )}
            <p
              className={`text-sm truncate flex-1 ${
                isUnread ? 'text-slate-200' : 'text-slate-400'
              }`}
            >
              {message.subject}
            </p>
          </div>
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
