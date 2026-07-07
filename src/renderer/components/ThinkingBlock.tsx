import { useState } from 'react';
import { ChevronDown, ChevronRight, Loader2 } from 'lucide-react';

interface ThinkingBlockProps {
  /** Label shown on the toggle (e.g. "Thinking..."). */
  label?: string;
  /** Accumulated thinking content. */
  content: string;
  /** When true, the block is actively thinking and shows a spinner. */
  live?: boolean;
  /** When true, render in a compact style suitable for terminal panes. */
  compact?: boolean;
  /** Force expanded state; otherwise internal toggle is used. */
  defaultExpanded?: boolean;
}

export function ThinkingBlock({
  label = 'Thinking...',
  content,
  live,
  compact,
  defaultExpanded = false,
}: ThinkingBlockProps) {
  const [expanded, setExpanded] = useState(defaultExpanded);

  if (live) {
    // Live mode is intentionally minimal: a single faded row with a spinner.
    // Showing the streaming preview here made the block flicker line-by-line.
    return (
      <div
        className={`inline-flex items-center gap-2 text-slate-500 bg-slate-800/40 rounded px-2 py-1 ${
          compact ? 'text-[11px]' : 'text-xs'
        }`}
        data-testid="thinking-live"
      >
        <Loader2 className={`w-3.5 h-3.5 animate-spin shrink-0 ${compact ? 'w-3 h-3' : ''}`} />
        <span className="italic">{label}</span>
      </div>
    );
  }

  return (
    <div className="border-l-2 border-slate-700 pl-2 my-1" data-testid="thinking-block">
      <button
        onClick={() => setExpanded((v) => !v)}
        className={`flex items-center gap-1 text-slate-500 hover:text-slate-300 transition-colors ${
          compact ? 'text-[11px]' : 'text-xs'
        }`}
        title={expanded ? 'Hide thinking' : 'Show thinking'}
      >
        {expanded ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
        <span className="italic">{label}</span>
      </button>
      {expanded && content && (
        <pre
          className={`mt-1 font-mono text-slate-400 italic whitespace-pre-wrap bg-slate-800/40 rounded p-2 ${
            compact ? 'text-[11px]' : 'text-xs'
          }`}
        >
          {content}
        </pre>
      )}
    </div>
  );
}
