import { MailMessage, PanelAction } from '@shared/types';
import { X, Clock, User, AlertTriangle, Flag } from 'lucide-react';
import { ActionButton } from '../ACP/ActionPanel';

interface MailDetailProps {
  message: MailMessage;
  actions?: PanelAction[];
  suggested?: string;
  onClose: () => void;
  onReply: () => void;
  onAction?: (action: PanelAction) => void;
}

type Priority = 'high' | 'flagged' | 'normal';

function getMessagePriority(message: MailMessage): Priority {
  if (message.from_agent === 'BAPert' || message.subject.startsWith('TASK:')) {
    return 'high';
  }
  if (message.subject.startsWith('CHANGES:')) {
    return 'flagged';
  }
  return 'normal';
}

export function MailDetail({ message, actions, suggested, onClose, onReply, onAction }: MailDetailProps) {
  const date = new Date(message.created_at);
  const formattedDate = date.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
  const priority = getMessagePriority(message);

  const handleAction = (action: PanelAction) => {
    if (action.action === 'reply') {
      onReply();
    } else if (onAction) {
      onAction(action);
    }
  };

  return (
    <div className="flex flex-col h-full bg-slate-900">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-slate-700">
        <div className="flex items-center gap-2 flex-1 min-w-0">
          {priority === 'high' && (
            <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 text-[10px] font-bold bg-red-500/20 text-red-400 rounded shrink-0">
              <AlertTriangle className="w-3 h-3" />
              HIGH
            </span>
          )}
          {priority === 'flagged' && (
            <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 text-[10px] font-bold bg-orange-500/20 text-orange-400 rounded shrink-0">
              <Flag className="w-3 h-3" />
              CHANGES
            </span>
          )}
          <h3 className="text-sm font-semibold text-slate-200 truncate">
            {message.subject}
          </h3>
        </div>
        <button
          onClick={onClose}
          className="p-1.5 text-slate-400 hover:text-slate-200 hover:bg-slate-800 rounded transition-colors shrink-0"
          title="Close"
        >
          <X className="w-4 h-4" />
        </button>
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

      {/* Actions bar */}
      {actions && actions.length > 0 && (
        <div className="border-t border-slate-700 px-4 py-3 space-y-3">
          {/* Suggested action hint */}
          {suggested && (
            <div className="text-xs text-cyan-400 font-mono">
              Suggested: {suggested}
            </div>
          )}

          {/* Action buttons */}
          <div className="flex flex-wrap gap-2">
            {actions.map((action, idx) => (
              <ActionButton
                key={`${action.action}-${idx}`}
                action={action}
                onExecute={() => handleAction(action)}
                isSuggested={suggested?.toLowerCase().includes(action.action.toLowerCase())}
                size="sm"
              />
            ))}
          </div>

          {/* Keyboard hints */}
          {actions.some(a => a.key) && (
            <div className="flex flex-wrap gap-2 text-[10px] text-slate-500">
              {actions.filter(a => a.key).map((action, idx) => (
                <span key={idx}>
                  <kbd className="px-1 py-0.5 bg-slate-800 rounded text-slate-400 font-mono">{action.key}</kbd>
                  {' '}{action.action}
                </span>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
