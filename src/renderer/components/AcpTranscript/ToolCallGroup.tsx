import { useState } from 'react';
import { ChevronDown, ChevronRight, Check, X } from 'lucide-react';
import type { AcpToolCall } from '@shared/acpTypes';
import { ToolCallCard } from './ToolCallCard';

interface ToolCallGroupProps {
  toolCalls: AcpToolCall[];
  shell?: boolean;
}

export function ToolCallGroup({ toolCalls, shell }: ToolCallGroupProps) {
  const [expanded, setExpanded] = useState(false);
  const count = toolCalls.length;
  if (count === 0) return null;

  const failedCount = toolCalls.filter((t) => t.status === 'failed').length;
  const completedCount = count - failedCount;

  if (shell) {
    // Compact shell-call block: inline toggle + last command preview, like a thinking block.
    const lastCommand = toolCalls[toolCalls.length - 1]?.title ?? 'Shell';
    return (
      <div className="my-1 border-l-2 border-slate-700 pl-2" data-testid="shell-call-group">
        <button
          onClick={() => setExpanded((v) => !v)}
          className="flex items-center gap-1 text-[11px] text-slate-500 hover:text-slate-300 transition-colors"
          title={expanded ? 'Hide shell calls' : 'Show shell calls'}
        >
          {expanded ? (
            <ChevronDown className="w-3.5 h-3.5 shrink-0" />
          ) : (
            <ChevronRight className="w-3.5 h-3.5 shrink-0" />
          )}
          {completedCount > 0 && <Check className="w-3 h-3 text-green-400 shrink-0" />}
          {failedCount > 0 && <X className="w-3 h-3 text-red-400 shrink-0" />}
          <span className="italic">
            {count} shell{count === 1 ? '' : 's'}
          </span>
          {!expanded && <span className="text-slate-600 truncate max-w-[12rem]" title={lastCommand}>— {lastCommand}</span>}
        </button>
        {expanded && (
          <div className="mt-1 space-y-1">
            {toolCalls.map((toolCall) => (
              <ToolCallCard key={toolCall.toolCallId} toolCall={toolCall} />
            ))}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="my-1 border border-slate-700 rounded bg-slate-800/40" data-testid="tool-call-group">
      <button
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-center gap-2 px-2 py-1 text-left text-xs text-slate-300 hover:bg-slate-700/30 transition-colors"
        title={expanded ? 'Hide tool calls' : 'Show tool calls'}
      >
        {expanded ? (
          <ChevronDown className="w-3.5 h-3.5 shrink-0" />
        ) : (
          <ChevronRight className="w-3.5 h-3.5 shrink-0" />
        )}
        <div className="flex items-center gap-1 shrink-0">
          {completedCount > 0 && <Check className="w-3.5 h-3.5 text-green-400" />}
          {failedCount > 0 && <X className="w-3.5 h-3.5 text-red-400" />}
        </div>
        <span className="font-terminal truncate">
          {count} tool{count === 1 ? '' : 's'}
          {failedCount > 0 && ` (${failedCount} failed)`}
        </span>
      </button>
      {expanded && (
        <div className="px-2 pb-2 space-y-1">
          {toolCalls.map((toolCall) => (
            <ToolCallCard key={toolCall.toolCallId} toolCall={toolCall} />
          ))}
        </div>
      )}
    </div>
  );
}
