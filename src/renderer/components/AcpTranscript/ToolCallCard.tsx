import { useState } from 'react';
import { ChevronDown, ChevronRight, Loader2, Check, X } from 'lucide-react';
import type { AcpContentBlock, AcpToolCall } from '@shared/acpTypes';

interface ToolCallCardProps {
  toolCall: AcpToolCall;
}

function textFromContentBlock(block: AcpContentBlock): string {
  return block.type === 'content' && block.content.type === 'text' ? block.content.text : '';
}

function contentText(toolCall: AcpToolCall): string {
  return toolCall.contentText ?? toolCall.content.map(textFromContentBlock).join('');
}

export function ToolCallCard({ toolCall }: ToolCallCardProps) {
  const [expanded, setExpanded] = useState(false);
  const isRunning = toolCall.status === 'in_progress';
  const isSuccess = toolCall.status === 'completed';
  const body = contentText(toolCall);

  return (
    <div
      className="my-1 border border-slate-700 rounded bg-slate-800/40"
      data-testid="tool-call-card"
    >
      <button
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-center gap-2 px-2 py-1.5 text-left text-xs text-slate-300 hover:bg-slate-700/30 transition-colors"
      >
        {expanded ? (
          <ChevronDown className="w-3.5 h-3.5 shrink-0" />
        ) : (
          <ChevronRight className="w-3.5 h-3.5 shrink-0" />
        )}
        {isRunning ? (
          <Loader2 className="w-3.5 h-3.5 animate-spin shrink-0" />
        ) : isSuccess ? (
          <Check className="w-3.5 h-3.5 text-green-400 shrink-0" />
        ) : (
          <X className="w-3.5 h-3.5 text-red-400 shrink-0" />
        )}
        <span className="font-terminal truncate">{toolCall.title}</span>
      </button>
      {expanded && body && (
        <pre className="px-2 pb-2 text-[11px] font-terminal text-slate-400 whitespace-pre-wrap break-words overflow-x-auto">
          {body}
        </pre>
      )}
    </div>
  );
}
