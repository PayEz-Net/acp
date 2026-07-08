import { Shield, Check, CheckCheck, X } from 'lucide-react';
import type { AcpPermissionOption, AcpToolCall } from '@shared/acpTypes';

interface PermissionRequestCardProps {
  toolCall: AcpToolCall;
  options: AcpPermissionOption[];
  onRespond: (optionId: string) => void;
}

function optionIcon(kind: AcpPermissionOption['kind']) {
  switch (kind) {
    case 'allow_once':
      return <Check className="w-3.5 h-3.5" />;
    case 'allow_always':
      return <CheckCheck className="w-3.5 h-3.5" />;
    case 'reject_once':
      return <X className="w-3.5 h-3.5" />;
    default:
      return null;
  }
}

function optionClass(kind: AcpPermissionOption['kind']): string {
  const base =
    'flex items-center gap-1.5 px-2.5 py-1.5 rounded text-[11px] font-medium transition-colors';
  switch (kind) {
    case 'allow_once':
      return `${base} bg-emerald-600/20 text-emerald-300 hover:bg-emerald-600/30 border border-emerald-600/40`;
    case 'allow_always':
      return `${base} bg-emerald-900/20 text-emerald-400 hover:bg-emerald-900/30 border border-emerald-700/40`;
    case 'reject_once':
      return `${base} bg-red-600/10 text-red-300 hover:bg-red-600/20 border border-red-600/30`;
    default:
      return `${base} bg-slate-700 text-slate-200 hover:bg-slate-600`;
  }
}

export function PermissionRequestCard({ toolCall, options, onRespond }: PermissionRequestCardProps) {
  return (
    <div
      className="my-2 border border-amber-600/30 rounded bg-amber-900/10 p-2"
      data-testid="permission-request-card"
    >
      <div className="flex items-start gap-2 mb-2">
        <Shield className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
        <div className="min-w-0">
          <div className="text-xs font-medium text-amber-200">Permission required</div>
          <div className="text-[11px] text-slate-400 truncate" title={toolCall.title}>
            {toolCall.title}
          </div>
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        {options.map((option) => (
          <button
            key={option.optionId}
            type="button"
            onClick={() => onRespond(option.optionId)}
            className={optionClass(option.kind)}
            data-testid={`permission-option-${option.optionId}`}
          >
            {optionIcon(option.kind)}
            {option.name}
          </button>
        ))}
      </div>
    </div>
  );
}
