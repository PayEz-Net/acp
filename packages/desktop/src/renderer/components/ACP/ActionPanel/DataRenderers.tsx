/**
 * Specialized data renderers for common ActionPanel data types.
 * These provide rich UI for mail, kanban, file data, etc.
 */

import { MailInboxData, MailMessageData, KanbanTaskData, FileData } from '@shared/types';

/**
 * Renders mail inbox data with message list
 */
export function MailInboxRenderer({ data }: { data: MailInboxData }) {
  return (
    <div className="space-y-3">
      {/* Stats */}
      <div className="flex items-center gap-4">
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 rounded-lg bg-violet-500/20 flex items-center justify-center">
            <svg className="w-4 h-4 text-violet-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
            </svg>
          </div>
          <div>
            <div className="text-lg font-bold text-white">{data.unread}</div>
            <div className="text-[10px] text-slate-500 uppercase">Unread</div>
          </div>
        </div>
        <div className="text-sm text-slate-400">
          of {data.total} total
        </div>
      </div>

      {/* Message list */}
      {data.messages.length > 0 && (
        <div className="space-y-1">
          {data.messages.map((msg, idx) => (
            <div
              key={msg.id}
              className="flex items-center gap-3 px-3 py-2 bg-slate-900/50 rounded-lg hover:bg-slate-900/70 transition-colors"
            >
              <span className="text-xs text-slate-500 font-mono w-4">{idx + 1}</span>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-white truncate">
                    {msg.from}
                  </span>
                  {msg.priority === 'high' && (
                    <span className="px-1.5 py-0.5 text-[10px] font-bold bg-red-500/20 text-red-400 rounded">
                      HIGH
                    </span>
                  )}
                </div>
                <div className="text-xs text-slate-400 truncate">{msg.subject}</div>
              </div>
              <kbd className="px-1.5 py-0.5 bg-slate-800 rounded text-[10px] font-mono text-slate-400">
                {idx + 1}
              </kbd>
            </div>
          ))}
        </div>
      )}

      {data.messages.length === 0 && (
        <div className="text-center py-6 text-slate-500 text-sm">
          No messages
        </div>
      )}
    </div>
  );
}

/**
 * Renders single mail message data
 */
export function MailMessageRenderer({ data }: { data: MailMessageData }) {
  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <span className="text-xs text-slate-500">From</span>
          <span className="text-sm font-medium text-white">{data.from}</span>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-xs text-slate-500">To</span>
          <span className="text-sm text-slate-300">{data.to}</span>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-xs text-slate-500">Subject</span>
          <span className="text-sm font-medium text-white">{data.subject}</span>
        </div>
      </div>

      {/* Body */}
      <div className="bg-slate-900/50 rounded-lg p-4">
        <pre className="text-sm text-slate-300 whitespace-pre-wrap font-sans">
          {data.body}
        </pre>
      </div>

      {/* Attachments */}
      {data.attachments && data.attachments.length > 0 && (
        <div className="space-y-2">
          <span className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">
            Attachments
          </span>
          <div className="flex flex-wrap gap-2">
            {data.attachments.map((att) => (
              <div
                key={att.path}
                className="flex items-center gap-2 px-3 py-1.5 bg-slate-800 rounded-lg"
              >
                <svg className="w-4 h-4 text-slate-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" />
                </svg>
                <span className="text-xs text-slate-300">{att.name}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Renders kanban task data
 */
export function KanbanTaskRenderer({ data }: { data: KanbanTaskData }) {
  const statusColors: Record<string, string> = {
    backlog: 'bg-slate-500/20 text-slate-400',
    ready: 'bg-blue-500/20 text-blue-400',
    in_progress: 'bg-amber-500/20 text-amber-400',
    review: 'bg-purple-500/20 text-purple-400',
    done: 'bg-emerald-500/20 text-emerald-400',
  };

  const priorityColors: Record<string, string> = {
    low: 'text-slate-400',
    normal: 'text-slate-300',
    high: 'text-amber-400',
    urgent: 'text-red-400',
  };

  return (
    <div className="space-y-4">
      {/* Title and status */}
      <div className="flex items-start justify-between gap-3">
        <h4 className="text-lg font-bold text-white">{data.title}</h4>
        <span className={`px-2 py-1 text-xs font-medium rounded ${statusColors[data.status] || statusColors.backlog}`}>
          {data.status.replace('_', ' ')}
        </span>
      </div>

      {/* Description */}
      {data.description && (
        <p className="text-sm text-slate-300">{data.description}</p>
      )}

      {/* Meta */}
      <div className="flex flex-wrap items-center gap-4 text-xs">
        {data.assignedTo && (
          <div className="flex items-center gap-1.5">
            <svg className="w-4 h-4 text-slate-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
            </svg>
            <span className="text-slate-300">{data.assignedTo}</span>
          </div>
        )}
        <div className={`flex items-center gap-1.5 ${priorityColors[data.priority]}`}>
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 21v-4m0 0V5a2 2 0 012-2h6.5l1 1H21l-3 6 3 6h-8.5l-1-1H5a2 2 0 00-2 2zm9-13.5V9" />
          </svg>
          <span>{data.priority}</span>
        </div>
        {data.dueDate && (
          <div className="flex items-center gap-1.5 text-slate-400">
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
            </svg>
            <span>{data.dueDate}</span>
          </div>
        )}
      </div>

      {/* Labels */}
      {data.labels && data.labels.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {data.labels.map((label) => (
            <span
              key={label}
              className="px-2 py-0.5 text-xs bg-slate-700 text-slate-300 rounded"
            >
              {label}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Renders file data with syntax highlighting placeholder
 */
export function FileDataRenderer({ data }: { data: FileData }) {
  return (
    <div className="space-y-3">
      {/* File info */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <svg className="w-5 h-5 text-slate-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
          </svg>
          <span className="text-sm font-mono text-slate-300">{data.path.split(/[/\\]/).pop()}</span>
        </div>
        <div className="flex items-center gap-3 text-xs">
          {data.language && (
            <span className="px-2 py-0.5 bg-slate-700 text-slate-300 rounded">
              {data.language}
            </span>
          )}
          <span className="text-slate-500">{data.lines} lines</span>
        </div>
      </div>

      {/* Status badges */}
      <div className="flex items-center gap-2">
        {data.recentlyModified && (
          <span className="px-2 py-0.5 text-[10px] bg-amber-500/20 text-amber-400 rounded">
            Recently Modified
          </span>
        )}
        {data.uncommittedChanges && (
          <span className="px-2 py-0.5 text-[10px] bg-orange-500/20 text-orange-400 rounded">
            Uncommitted Changes
          </span>
        )}
      </div>

      {/* Content preview */}
      <div className="relative">
        <pre className="text-xs text-slate-400 bg-slate-900/50 p-3 rounded-lg overflow-auto max-h-64 font-mono">
          {data.content.slice(0, 2000)}
          {data.content.length > 2000 && '\n\n... (truncated)'}
        </pre>
      </div>

      {/* Path */}
      <div className="text-[10px] text-slate-600 font-mono truncate">{data.path}</div>
    </div>
  );
}
