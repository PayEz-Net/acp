import { useEffect } from 'react';
import { usePartyStore } from '../../stores/partyStore';
import { useAppStore } from '../../stores/appStore';
import { X, Users, Zap, MessageCircle } from 'lucide-react';

interface PartyPanelProps {
  isOpen: boolean;
  onClose: () => void;
}

const ZONE_LABELS: Record<string, string> = {
  entrance: 'Entrance',
  bar: 'Bar Zone',
  'table-db': 'DB Architecture',
  'table-ui': 'UI Components',
  'table-api': 'API Routes',
  'table-qa': 'QA Testing',
  lounge: 'Lounge',
};

const MINGLE_ICONS: Record<string, string> = {
  gossip: '💬',
  chit_chat: '🗣️',
  deep_talk: '🧠',
};

export function PartyPanel({ isOpen, onClose }: PartyPanelProps) {
  const { signals, relevanceMatrix, activeMingles, isPaused, loading, fetchPartyState, fetchRelevance } = usePartyStore();
  const { backendAvailable } = useAppStore();

  // Poll party state every 5s
  useEffect(() => {
    if (!isOpen || !backendAvailable) return;
    fetchPartyState();
    fetchRelevance();
    const interval = setInterval(() => {
      fetchPartyState();
      fetchRelevance();
    }, 5000);
    return () => clearInterval(interval);
  }, [isOpen, backendAvailable, fetchPartyState, fetchRelevance]);

  if (!isOpen) return null;

  const signalList = Object.values(signals);
  const topRelevance = [...relevanceMatrix].sort((a, b) => b.score - a.score).slice(0, 10);

  return (
    <div className="w-80 bg-slate-900 border-l border-slate-700 flex flex-col h-full overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-slate-700">
        <div className="flex items-center gap-2">
          <Users className="w-4 h-4 text-violet-400" />
          <span className="text-sm font-semibold text-slate-200">Party Engine</span>
          {isPaused && <span className="text-xs text-amber-400">(Paused)</span>}
        </div>
        <button onClick={onClose} className="text-slate-400 hover:text-white">
          <X className="w-4 h-4" />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto">
        {!backendAvailable ? (
          <div className="p-4 text-sm text-slate-500 text-center">Backend required for party engine</div>
        ) : loading && signalList.length === 0 ? (
          <div className="p-4 text-sm text-slate-500 text-center">Loading...</div>
        ) : (
          <>
            {/* Agent Map */}
            <div className="p-3 border-b border-slate-800">
              <h3 className="text-xs font-semibold text-slate-400 uppercase mb-2">Agents</h3>
              {signalList.length === 0 ? (
                <div className="text-xs text-slate-500">No agent signals</div>
              ) : (
                <div className="space-y-1">
                  {signalList.map((signal) => (
                    <div key={signal.agentId} className="flex items-center gap-2 py-1">
                      <div className="w-2 h-2 rounded-full bg-green-500" />
                      <span className="text-sm text-slate-200 font-medium">{signal.agentName}</span>
                      <span className="text-xs text-slate-500">{ZONE_LABELS[signal.location] || signal.location}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Active Mingles */}
            <div className="p-3 border-b border-slate-800">
              <h3 className="text-xs font-semibold text-slate-400 uppercase mb-2 flex items-center gap-1">
                <MessageCircle className="w-3 h-3" /> Active Mingles
              </h3>
              {activeMingles.length === 0 ? (
                <div className="text-xs text-slate-500">No active interactions</div>
              ) : (
                <div className="space-y-2">
                  {activeMingles.map((mingle) => (
                    <div key={mingle.id} className="bg-slate-800 rounded-lg p-2">
                      <div className="flex items-center gap-1 text-sm">
                        <span>{MINGLE_ICONS[mingle.type] || '💬'}</span>
                        <span className="text-slate-200">{mingle.agents[0]}</span>
                        <Zap className="w-3 h-3 text-amber-400" />
                        <span className="text-slate-200">{mingle.agents[1]}</span>
                      </div>
                      <div className="text-xs text-slate-500 mt-1">
                        {mingle.type.replace('_', ' ')} {mingle.topic ? `— ${mingle.topic}` : ''}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Relevance Matrix */}
            <div className="p-3">
              <h3 className="text-xs font-semibold text-slate-400 uppercase mb-2 flex items-center gap-1">
                <Zap className="w-3 h-3" /> Top Relevance
              </h3>
              {topRelevance.length === 0 ? (
                <div className="text-xs text-slate-500">No relevance data</div>
              ) : (
                <div className="space-y-1">
                  {topRelevance.map((r, i) => (
                    <div key={i} className="flex items-center justify-between text-sm">
                      <span className="text-slate-300">
                        {r.agentA} ↔ {r.agentB}
                      </span>
                      <span className={`font-mono text-xs ${
                        r.score >= 70 ? 'text-green-400' :
                        r.score >= 40 ? 'text-amber-400' :
                        'text-slate-500'
                      }`}>
                        {r.score}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
