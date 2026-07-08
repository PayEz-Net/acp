import { useState } from 'react';
import { X, LayoutGrid, History as HistoryIcon } from 'lucide-react';
import { CheckinBoard } from './CheckinBoard';
import { CheckinHistory } from './CheckinHistory';
import { OverlayPanel } from '../Layout/OverlayPanel';

/**
 * Team Check-in — its OWN top-level surface (D5), decoupled from Autonomy.
 * The supervisor / unattended machinery is unrelated to the dev-run check-in;
 * activity telemetry stays in Autonomy/observability. Hosts the durable-round
 * board + history (read surfaces). Call-standup (open a round) pairs with
 * DotNetPert's W2 capture loop.
 */
interface CheckinPanelProps {
  onClose: () => void;
}

type CheckinTab = 'board' | 'history';

export function CheckinPanel({ onClose }: CheckinPanelProps) {
  const [tab, setTab] = useState<CheckinTab>('board');

  return (
    <OverlayPanel isOpen onClose={onClose} width="w-[600px]" className="bg-slate-900 border-slate-700">
      <div className="flex items-center gap-1 border-b border-slate-700 py-2 pl-3 pr-12">
          <TabButton active={tab === 'board'} onClick={() => setTab('board')} Icon={LayoutGrid} label="Board" />
          <TabButton active={tab === 'history'} onClick={() => setTab('history')} Icon={HistoryIcon} label="History" />
        </div>
        <button
          onClick={onClose}
          aria-label="Close"
          className="absolute right-3 top-2.5 z-10 text-slate-400 hover:text-slate-200"
        >
          <X className="h-5 w-5" />
        </button>
      <div className="flex flex-1 flex-col overflow-hidden">
        {tab === 'board' ? <CheckinBoard /> : <CheckinHistory />}
      </div>
    </OverlayPanel>
  );
}

function TabButton({
  active,
  onClick,
  Icon,
  label,
}: {
  active: boolean;
  onClick: () => void;
  Icon: typeof LayoutGrid;
  label: string;
}) {
  return (
    <button
      onClick={onClick}
      className={`inline-flex items-center gap-1.5 rounded px-3 py-1.5 text-xs font-semibold ${
        active ? 'bg-slate-700 text-slate-100' : 'text-slate-400 hover:text-slate-200'
      }`}
    >
      <Icon className="h-3.5 w-3.5" />
      {label}
    </button>
  );
}
