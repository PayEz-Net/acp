import { Loader2 } from 'lucide-react';

interface ActivityIndicatorProps {
  status: 'thinking' | 'tool' | 'answering' | string;
}

export function ActivityIndicator({ status }: ActivityIndicatorProps) {
  const label =
    status === 'thinking' ? 'Thinking' :
    status === 'tool' ? 'Using tool' :
    status === 'answering' ? 'Answering' :
    'Working';

  return (
    <div className="flex items-center gap-2 text-slate-500 text-xs py-1" data-testid="activity-indicator">
      <Loader2 className="w-3.5 h-3.5 animate-spin" />
      <span className="italic">{label}...</span>
    </div>
  );
}
