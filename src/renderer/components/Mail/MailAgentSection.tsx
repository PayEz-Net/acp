import { useState } from 'react';
import { ChevronDown, ChevronRight, Loader2 } from 'lucide-react';
import { MailMessage, AgentState } from '@shared/types';
import { MailItem } from './MailItem';

const STATUS_COLORS: Record<AgentState['status'], string> = {
  offline: '#64748b',
  starting: '#a855f7',
  ready: '#3b82f6',
  busy: '#f59e0b',
  idle: '#22c55e',
  error: '#ef4444',
};

interface MailAgentSectionProps {
  agent: string;
  messages: MailMessage[];
  unreadCount: number;
  isLoading: boolean;
  selectedMessageId?: number;
  onSelectMessage: (message: MailMessage) => void;
  color?: string;
  status?: AgentState['status'];
}

export function MailAgentSection({
  agent,
  messages,
  unreadCount,
  isLoading,
  selectedMessageId,
  onSelectMessage,
  color: _color = '#7c3aed',
  status = 'offline',
}: MailAgentSectionProps) {
  const [isExpanded, setIsExpanded] = useState(true);

  return (
    <div className="border-b border-slate-700/50 last:border-b-0">
      {/* Header */}
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className="w-full flex items-center gap-2 px-3 py-2 hover:bg-slate-800/50 transition-colors"
      >
        {/* Expand/collapse icon */}
        {isExpanded ? (
          <ChevronDown className="w-4 h-4 text-slate-400" />
        ) : (
          <ChevronRight className="w-4 h-4 text-slate-400" />
        )}

        {/* Agent status indicator */}
        <div
          className={`w-2 h-2 rounded-full${status === 'starting' || status === 'busy' ? ' animate-pulse' : ''}`}
          style={{ backgroundColor: STATUS_COLORS[status] }}
        />

        {/* Agent name */}
        <span className="text-sm font-medium text-slate-200 flex-1 text-left">
          {agent}
        </span>

        {/* Unread badge */}
        {unreadCount > 0 && (
          <span className="px-1.5 py-0.5 text-xs font-semibold bg-violet-600 text-white rounded-full">
            {unreadCount}
          </span>
        )}

        {/* Loading indicator */}
        {isLoading && (
          <Loader2 className="w-3 h-3 text-slate-400 animate-spin" />
        )}
      </button>

      {/* Messages */}
      {isExpanded && (
        <div className="px-2 pb-2 space-y-1">
          {messages.length === 0 ? (
            <p className="text-xs text-slate-500 px-3 py-2">No messages</p>
          ) : (
            messages.slice(0, 10).map((message) => (
              <MailItem
                key={message.message_id}
                message={message}
                isSelected={selectedMessageId === message.message_id}
                onClick={() => onSelectMessage(message)}
              />
            ))
          )}
          {messages.length > 10 && (
            <p className="text-xs text-slate-500 px-3 py-1">
              +{messages.length - 10} more messages
            </p>
          )}
        </div>
      )}
    </div>
  );
}
