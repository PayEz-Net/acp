import {
  CheckCircle,
  XCircle,
  Play,
  Eye,
  ThumbsUp,
  ThumbsDown,
  Flag,
} from 'lucide-react';
import { StandupEntry as StandupEntryType, StandupEventType } from '@shared/types';

interface StandupEntryProps {
  entry: StandupEntryType;
  onTaskClick?: (taskId: number) => void;
}

const EVENT_CONFIG: Record<StandupEventType, { icon: typeof CheckCircle; color: string; bg: string }> = {
  completed: { icon: CheckCircle, color: 'text-green-400', bg: 'bg-green-400/10' },
  blocked: { icon: XCircle, color: 'text-red-400', bg: 'bg-red-400/10' },
  started: { icon: Play, color: 'text-blue-400', bg: 'bg-blue-400/10' },
  review_requested: { icon: Eye, color: 'text-yellow-400', bg: 'bg-yellow-400/10' },
  review_passed: { icon: ThumbsUp, color: 'text-green-400', bg: 'bg-green-400/10' },
  review_failed: { icon: ThumbsDown, color: 'text-orange-400', bg: 'bg-orange-400/10' },
  milestone_done: { icon: Flag, color: 'text-purple-400', bg: 'bg-purple-400/10' },
};

function formatTimeAgo(dateStr: string): string {
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);

  if (diffMins < 1) return 'just now';
  if (diffMins < 60) return `${diffMins}m ago`;

  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return `${diffHours}h ago`;

  const diffDays = Math.floor(diffHours / 24);
  return `${diffDays}d ago`;
}

export function StandupEntryCard({ entry, onTaskClick }: StandupEntryProps) {
  const config = EVENT_CONFIG[entry.event_type];
  const Icon = config.icon;

  return (
    <div className="flex gap-3 p-3 border-b border-slate-700/50 hover:bg-slate-800/30 transition-colors">
      {/* Agent Avatar */}
      <div className="flex-shrink-0">
        <div className={`w-8 h-8 rounded-full ${config.bg} flex items-center justify-center`}>
          <span className={`text-xs font-bold ${config.color}`}>
            {entry.agent.charAt(0)}
          </span>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 min-w-0">
        {/* Header */}
        <div className="flex items-center justify-between gap-2">
          <span className="font-medium text-slate-200 text-sm">{entry.agent}</span>
          <span className="text-xs text-slate-500 flex-shrink-0">
            {formatTimeAgo(entry.created_at)}
          </span>
        </div>

        {/* Event */}
        <div className="flex items-center gap-2 mt-1">
          <Icon className={`w-4 h-4 ${config.color}`} />
          <span className="text-sm text-slate-300 truncate">{entry.summary}</span>
        </div>

        {/* Task Link */}
        {entry.task_id && onTaskClick && (
          <button
            onClick={() => onTaskClick(entry.task_id!)}
            className="mt-2 text-xs text-vibe-400 hover:text-vibe-300 transition-colors"
          >
            View Task #{entry.task_id}
          </button>
        )}
      </div>
    </div>
  );
}
