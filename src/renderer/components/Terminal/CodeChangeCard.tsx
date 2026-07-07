import { useState } from 'react';
import type { CodeChangeLine } from '../../lib/terminalStream';

interface CodeChangeCardProps {
  codeChange: CodeChangeLine;
  compact?: boolean;
}

const COLLAPSE_THRESHOLD = 20;
const COLLAPSE_PREVIEW = 10;

export function CodeChangeCard({ codeChange, compact }: CodeChangeCardProps) {
  const [expanded, setExpanded] = useState(false);

  const allLines = codeChange.hunks.flatMap((hunk) => hunk.lines);
  const totalLines = allLines.length;
  const isCollapsible = totalLines > COLLAPSE_THRESHOLD;
  const visibleLines = isCollapsible && !expanded ? allLines.slice(0, COLLAPSE_PREVIEW) : allLines;
  const hiddenCount = totalLines - visibleLines.length;

  const badgeColor =
    codeChange.operation === 'created'
      ? 'bg-emerald-500/20 text-emerald-400 border-emerald-500/30'
      : codeChange.operation === 'deleted'
        ? 'bg-rose-500/20 text-rose-400 border-rose-500/30'
        : 'bg-amber-500/20 text-amber-400 border-amber-500/30';

  return (
    <div className="my-1 rounded-lg border border-slate-700 bg-slate-800/60 overflow-hidden">
      <div className="flex items-center gap-2 px-2 py-1.5 border-b border-slate-700 bg-slate-800/80">
        <span
          className={`text-[10px] uppercase tracking-wide font-semibold px-1.5 py-0.5 rounded border ${badgeColor}`}
        >
          {codeChange.operation}
        </span>
        <span
          className={`text-slate-300 font-mono truncate ${compact ? 'text-[11px]' : 'text-xs'}`}
          title={codeChange.filePath}
        >
          {codeChange.filePath}
        </span>
      </div>
      <pre
        className={`p-2 overflow-x-auto ${compact ? 'text-[11px]' : 'text-xs'} leading-tight font-mono bg-slate-900/50`}
      >
        {visibleLines.map((l, idx) => {
          const color =
            l.type === 'add' ? 'text-emerald-400' : l.type === 'remove' ? 'text-rose-400' : 'text-slate-500';
          const prefix = l.type === 'add' ? '+' : l.type === 'remove' ? '-' : ' ';
          return (
            <div key={idx} className={`${color} whitespace-pre`}>
              {prefix} {l.text}
            </div>
          );
        })}
      </pre>
      {isCollapsible && (
        <button
          onClick={() => setExpanded((e) => !e)}
          className="w-full px-2 py-1 text-[10px] text-slate-400 hover:text-slate-200 hover:bg-slate-700/50 transition-colors text-left"
        >
          {expanded ? 'Show less' : `Show ${hiddenCount} more lines`}
        </button>
      )}
    </div>
  );
}
