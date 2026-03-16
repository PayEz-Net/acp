import { useEffect, useState, useRef, useCallback } from 'react';
import { X, RefreshCw, UserPlus, CheckCircle, Clock, AlertCircle, Briefcase, XCircle, Mail, Terminal } from 'lucide-react';
import { useContractorStore, ActiveContractor, ContractorProfile, ContractMailMessage } from '../../stores/contractorStore';
import { useAppStore } from '../../stores/appStore';

interface ContractorPanelProps {
  isOpen: boolean;
  onClose: () => void;
}

export function ContractorPanel({ isOpen, onClose }: ContractorPanelProps) {
  const {
    activeContractors, pool, selectedContractor, showHirePicker,
    loading, poolLoading,
    fetchActive, fetchPool, completeContract,
    setSelectedContractor, setShowHirePicker,
  } = useContractorStore();
  const { backendAvailable } = useAppStore();

  useEffect(() => {
    if (!isOpen || !backendAvailable) return;
    fetchActive();
    const interval = setInterval(fetchActive, 30000);
    return () => clearInterval(interval);
  }, [isOpen, backendAvailable, fetchActive]);

  if (!isOpen) return null;

  return (
    <div className="w-80 bg-slate-900 border-l border-slate-700 flex flex-col h-full overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-slate-700">
        <div className="flex items-center gap-2">
          <Briefcase className="w-4 h-4 text-emerald-400" />
          <span className="text-sm font-semibold text-slate-200">Contractors</span>
          {activeContractors.length > 0 && (
            <span className="text-xs px-1.5 py-0.5 rounded-full bg-emerald-900/50 text-emerald-300">
              {activeContractors.filter(c => c.contract.status === 'active').length}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={() => { fetchPool(); setShowHirePicker(true); }}
            className="p-1.5 text-emerald-400 hover:text-emerald-300 hover:bg-slate-800 rounded transition-colors"
            title="Hire contractor"
          >
            <UserPlus className="w-4 h-4" />
          </button>
          <button
            onClick={fetchActive}
            className="p-1.5 text-slate-400 hover:text-slate-200 hover:bg-slate-800 rounded transition-colors"
            title="Refresh"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          </button>
          <button
            onClick={onClose}
            className="p-1.5 text-slate-400 hover:text-slate-200 hover:bg-slate-800 rounded transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>

      {!backendAvailable ? (
        <div className="p-4 text-sm text-slate-500">Backend required for contractors</div>
      ) : showHirePicker ? (
        <HirePicker
          pool={pool}
          loading={poolLoading}
          onClose={() => setShowHirePicker(false)}
        />
      ) : selectedContractor ? (
        <ProfileCard
          contractor={selectedContractor}
          onBack={() => setSelectedContractor(null)}
          onComplete={completeContract}
          onCancel={useContractorStore.getState().cancelContract}
        />
      ) : (
        <ContractorList
          contractors={activeContractors}
          loading={loading}
          onSelect={setSelectedContractor}
        />
      )}
    </div>
  );
}

// --- Contractor List ---

function ContractorList({
  contractors,
  loading,
  onSelect,
}: {
  contractors: ActiveContractor[];
  loading: boolean;
  onSelect: (c: ActiveContractor) => void;
}) {
  const active = contractors.filter(c => c.contract.status === 'active');
  const queued = contractors.filter(c => c.contract.status === 'queued');
  const done = contractors.filter(c => !['active', 'queued'].includes(c.contract.status));

  if (loading && contractors.length === 0) {
    return <div className="p-4 text-sm text-slate-500">Loading...</div>;
  }

  if (contractors.length === 0) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center p-6 text-center">
        <Briefcase className="w-8 h-8 text-slate-600 mb-3" />
        <p className="text-sm text-slate-400">No contractors hired</p>
        <p className="text-xs text-slate-500 mt-1">Click + to hire from the pool</p>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto">
      {active.length > 0 && (
        <div className="p-2">
          <div className="text-xs font-medium text-slate-500 uppercase tracking-wider px-2 py-1">
            Active ({active.length})
          </div>
          {active.map(c => (
            <ContractorListItem key={c.contract.id} contractor={c} onSelect={onSelect} />
          ))}
        </div>
      )}
      {queued.length > 0 && (
        <div className="p-2">
          <div className="text-xs font-medium text-slate-500 uppercase tracking-wider px-2 py-1">
            Queued ({queued.length})
          </div>
          {queued.map((c, i) => (
            <ContractorListItem key={c.contract.id} contractor={c} onSelect={onSelect} queuePosition={i + 1} />
          ))}
        </div>
      )}
      {done.length > 0 && (
        <div className="p-2">
          <div className="text-xs font-medium text-slate-500 uppercase tracking-wider px-2 py-1">
            Completed
          </div>
          {done.map(c => (
            <ContractorListItem key={c.contract.id} contractor={c} onSelect={onSelect} />
          ))}
        </div>
      )}
    </div>
  );
}

// --- List Item ---

function ContractorListItem({
  contractor,
  onSelect,
  queuePosition,
}: {
  contractor: ActiveContractor;
  onSelect: (c: ActiveContractor) => void;
  queuePosition?: number;
}) {
  const { agent, contract } = contractor;
  const profile = contract.profile_snapshot;

  return (
    <button
      onClick={() => onSelect(contractor)}
      className="w-full text-left p-2 rounded hover:bg-slate-800 transition-colors group"
    >
      <div className="flex items-center gap-2">
        <div className={`w-2 h-2 rounded-full flex-shrink-0 ${
          contract.status === 'active' ? 'bg-emerald-400' :
          contract.status === 'queued' ? 'bg-blue-400' :
          contract.status === 'completed' ? 'bg-slate-500' :
          contract.status === 'expired' ? 'bg-amber-500' :
          'bg-red-500'
        }`} />
        <span className="text-sm font-medium text-slate-200 truncate">
          {agent.display_name || agent.name}
        </span>
        <StatusBadge status={contract.status} />
        {queuePosition != null && (
          <span className="text-[10px] text-blue-400 ml-auto flex-shrink-0">#{queuePosition}</span>
        )}
      </div>
      {profile?.description && (
        <p className="text-xs text-slate-500 mt-0.5 ml-4 truncate">{profile.description}</p>
      )}
      <div className="flex items-center gap-2 mt-1 ml-4">
        <span className="text-[10px] text-slate-600 truncate">{contract.contract_subject}</span>
      </div>
      {contract.hired_by_name && (
        <div className="text-[10px] text-slate-600 mt-0.5 ml-4">
          Hired by {contract.hired_by_name}
        </div>
      )}
    </button>
  );
}

// --- Status Badge ---

function StatusBadge({ status }: { status: string }) {
  const styles: Record<string, string> = {
    active: 'text-emerald-400 bg-emerald-900/30',
    queued: 'text-blue-400 bg-blue-900/30',
    completed: 'text-slate-400 bg-slate-800',
    expired: 'text-amber-400 bg-amber-900/30',
    cancelled: 'text-red-400 bg-red-900/30',
  };

  return (
    <span className={`text-[10px] px-1.5 py-0.5 rounded ml-auto flex-shrink-0 ${styles[status] || styles.active}`}>
      {status}
    </span>
  );
}

// --- Profile Card ---

function ProfileCard({
  contractor,
  onBack,
  onComplete,
  onCancel,
}: {
  contractor: ActiveContractor;
  onBack: () => void;
  onComplete: (contractId: number) => Promise<boolean>;
  onCancel: (contractId: number, reason?: string) => Promise<boolean>;
}) {
  const { agent, contract } = contractor;
  const profile = contract.profile_snapshot;
  const [completing, setCompleting] = useState(false);
  const [completeError, setCompleteError] = useState('');
  const [showCancelConfirm, setShowCancelConfirm] = useState(false);
  const [cancelReason, setCancelReason] = useState('');
  const [cancelling, setCancelling] = useState(false);
  const [mailThread, setMailThread] = useState<ContractMailMessage[]>([]);
  const [mailLoading, setMailLoading] = useState(false);

  useEffect(() => {
    setMailLoading(true);
    useContractorStore.getState().fetchContractMail(agent.name, contract.id)
      .then(setMailThread)
      .finally(() => setMailLoading(false));
  }, [agent.name, contract.id]);

  const handleComplete = async () => {
    setCompleting(true);
    setCompleteError('');
    const success = await onComplete(contract.id);
    setCompleting(false);
    if (success) {
      onBack();
    } else {
      setCompleteError('Failed to complete contract. Try again.');
    }
  };

  const handleCancel = async () => {
    setCancelling(true);
    const success = await onCancel(contract.id, cancelReason.trim() || undefined);
    setCancelling(false);
    if (success) {
      onBack();
    } else {
      setCompleteError('Failed to cancel contract. Try again.');
    }
  };

  return (
    <div className="flex-1 flex flex-col overflow-y-auto">
      {/* Back button */}
      <button
        onClick={onBack}
        className="flex items-center gap-1 px-4 py-2 text-xs text-slate-400 hover:text-slate-200 transition-colors"
      >
        &larr; Back to list
      </button>

      {/* Card */}
      <div className="px-4 pb-4 space-y-3">
        {/* Name + status */}
        <div className="flex items-center justify-between">
          <h3 className="text-base font-semibold text-slate-100">
            {agent.display_name || agent.name}
          </h3>
          <StatusBadge status={contract.status} />
        </div>

        {/* Description */}
        {(profile?.description || agent.role) && (
          <p className="text-sm text-slate-400">{profile?.description || agent.role}</p>
        )}

        {/* Model */}
        {(profile?.model || agent.model) && (
          <div className="flex items-center gap-2">
            <span className="text-xs text-slate-500">Model:</span>
            <span className="text-xs text-slate-300">{profile?.model || agent.model}</span>
          </div>
        )}

        {/* Tools */}
        {(profile?.tools || agent.expertise_json?.tools) && (
          <div>
            <span className="text-xs text-slate-500">Tools:</span>
            <div className="flex flex-wrap gap-1 mt-1">
              {(profile?.tools || agent.expertise_json?.tools || []).map(tool => (
                <span key={tool} className="text-[10px] px-1.5 py-0.5 rounded bg-slate-800 text-slate-300 border border-slate-700">
                  {tool}
                </span>
              ))}
            </div>
          </div>
        )}

        {/* Contract details */}
        <div className="border-t border-slate-800 pt-3 space-y-2">
          <div className="flex items-start gap-2">
            <Briefcase className="w-3.5 h-3.5 text-slate-500 mt-0.5 flex-shrink-0" />
            <span className="text-xs text-slate-300">{contract.contract_subject}</span>
          </div>
          {contract.hired_by_name && (
            <div className="flex items-center gap-2">
              <UserPlus className="w-3.5 h-3.5 text-slate-500 flex-shrink-0" />
              <span className="text-xs text-slate-300">Hired by {contract.hired_by_name}</span>
            </div>
          )}
          <div className="flex items-center gap-2">
            <Clock className="w-3.5 h-3.5 text-slate-500 flex-shrink-0" />
            <span className="text-xs text-slate-300">
              {new Date(contract.created_at).toLocaleString()}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <AlertCircle className="w-3.5 h-3.5 text-slate-500 flex-shrink-0" />
            <span className="text-xs text-slate-300">Timeout: {contract.timeout_hours}h</span>
          </div>
          {contract.cancel_reason && (
            <div className="text-xs text-red-400">
              Cancelled: {contract.cancel_reason}
            </div>
          )}
          {contract.session_started_at && (
            <DurationDisplay
              startedAt={contract.session_started_at}
              endedAt={contract.session_ended_at}
              status={contract.status}
            />
          )}
        </div>

        {/* Action buttons */}
        {contract.status === 'active' && (
          <div className="space-y-2">
            <button
              onClick={handleComplete}
              disabled={completing || cancelling}
              className="w-full flex items-center justify-center gap-2 py-2 px-3 rounded bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white text-sm font-medium transition-colors"
            >
              <CheckCircle className="w-4 h-4" />
              {completing ? 'Completing...' : 'Mark Complete'}
            </button>
            {!showCancelConfirm ? (
              <button
                onClick={() => setShowCancelConfirm(true)}
                disabled={completing}
                className="w-full flex items-center justify-center gap-2 py-1.5 px-3 rounded border border-red-800/50 text-red-400 hover:bg-red-900/20 text-xs font-medium transition-colors"
              >
                <XCircle className="w-3.5 h-3.5" />
                Cancel Contract
              </button>
            ) : (
              <div className="border border-red-800/50 rounded p-2 space-y-2 bg-red-900/10">
                <p className="text-xs text-red-300">Cancel this contract?</p>
                <input
                  type="text"
                  placeholder="Reason (optional)"
                  value={cancelReason}
                  onChange={(e) => setCancelReason(e.target.value)}
                  className="w-full px-2 py-1.5 text-xs bg-slate-800 border border-slate-700 rounded text-slate-200 placeholder-slate-500 focus:outline-none focus:border-red-500"
                  autoFocus
                  onKeyDown={(e) => { if (e.key === 'Escape') setShowCancelConfirm(false); }}
                />
                <div className="flex gap-1">
                  <button
                    onClick={handleCancel}
                    disabled={cancelling}
                    className="flex-1 text-xs py-1 rounded bg-red-600 hover:bg-red-500 disabled:opacity-50 text-white transition-colors"
                  >
                    {cancelling ? 'Cancelling...' : 'Confirm Cancel'}
                  </button>
                  <button
                    onClick={() => { setShowCancelConfirm(false); setCancelReason(''); }}
                    className="text-xs py-1 px-2 rounded bg-slate-800 text-slate-400 hover:text-slate-200 transition-colors"
                  >
                    Back
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
        {completeError && (
          <div className="text-xs text-red-400 bg-red-900/20 border border-red-800/50 rounded px-2 py-1">
            {completeError}
          </div>
        )}

        {contract.completed_at && (
          <div className="text-xs text-slate-500">
            Completed: {new Date(contract.completed_at).toLocaleString()}
          </div>
        )}

        {/* Session output (active/queued contracts with a session) */}
        {(contract.status === 'active' || contract.status === 'queued') && (
          <SessionOutputLog contractId={contract.id} hasSession={!!contract.session_pid} />
        )}

        {/* Mail thread */}
        <ContractMailThread messages={mailThread} loading={mailLoading} />
      </div>
    </div>
  );
}

// --- Contract Mail Thread ---

function ContractMailThread({
  messages,
  loading,
}: {
  messages: ContractMailMessage[];
  loading: boolean;
}) {
  if (loading) {
    return (
      <div className="border-t border-slate-800 pt-3">
        <div className="flex items-center gap-1.5 mb-2">
          <Mail className="w-3.5 h-3.5 text-slate-500" />
          <span className="text-xs font-medium text-slate-400">Mail Thread</span>
        </div>
        <div className="text-xs text-slate-500">Loading...</div>
      </div>
    );
  }

  if (messages.length === 0) {
    return (
      <div className="border-t border-slate-800 pt-3">
        <div className="flex items-center gap-1.5 mb-2">
          <Mail className="w-3.5 h-3.5 text-slate-500" />
          <span className="text-xs font-medium text-slate-400">Mail Thread</span>
        </div>
        <div className="text-xs text-slate-500">No messages yet</div>
      </div>
    );
  }

  return (
    <div className="border-t border-slate-800 pt-3">
      <div className="flex items-center gap-1.5 mb-2">
        <Mail className="w-3.5 h-3.5 text-slate-500" />
        <span className="text-xs font-medium text-slate-400">Mail Thread ({messages.length})</span>
      </div>
      <div className="space-y-2 max-h-60 overflow-y-auto">
        {messages.map(msg => (
          <div key={msg.id} className="rounded bg-slate-800/50 border border-slate-700/50 p-2">
            <div className="flex items-center justify-between mb-1">
              <span className="text-[10px] font-medium text-slate-300">{msg.from_agent}</span>
              <span className="text-[10px] text-slate-600">
                {new Date(msg.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
              </span>
            </div>
            {msg.subject && (
              <div className="text-[10px] text-slate-400 font-medium mb-0.5">{msg.subject}</div>
            )}
            <div className="text-xs text-slate-400 whitespace-pre-wrap break-words">{msg.body}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

// --- Duration Display ---

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  if (m < 60) return `${m}m ${s}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

function DurationDisplay({
  startedAt,
  endedAt,
  status,
}: {
  startedAt: string;
  endedAt?: string;
  status: string;
}) {
  const [elapsed, setElapsed] = useState(0);
  const isLive = !endedAt && (status === 'active' || status === 'queued');

  useEffect(() => {
    const start = new Date(startedAt).getTime();
    const calcElapsed = () => {
      const end = endedAt ? new Date(endedAt).getTime() : Date.now();
      return Math.max(0, Math.floor((end - start) / 1000));
    };
    setElapsed(calcElapsed());
    if (!isLive) return;
    const interval = setInterval(() => setElapsed(calcElapsed()), 1000);
    return () => clearInterval(interval);
  }, [startedAt, endedAt, isLive]);

  const label = isLive ? 'Running for' : 'Completed in';
  const color = isLive ? 'text-emerald-400' : 'text-slate-400';

  return (
    <div className="flex items-center gap-2">
      <Clock className={`w-3.5 h-3.5 flex-shrink-0 ${color}`} />
      <span className={`text-xs ${color}`}>
        {label} {formatDuration(elapsed)}
      </span>
    </div>
  );
}

// --- Session Output Log ---

function SessionOutputLog({
  contractId,
  hasSession,
}: {
  contractId: number;
  hasSession: boolean;
}) {
  const [lines, setLines] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const linesRef = useRef<string[]>([]);
  const rafRef = useRef<number>(0);

  // Fetch initial output
  useEffect(() => {
    if (!hasSession) return;
    setLoading(true);
    useContractorStore.getState().fetchContractOutput(contractId)
      .then(output => {
        linesRef.current = output.lines;
        setLines(output.lines);
      })
      .finally(() => setLoading(false));
  }, [contractId, hasSession]);

  // Listen for session-output SSE events via store subscription
  const appendLine = useCallback((line: string) => {
    linesRef.current = [...linesRef.current.slice(-99), line];
    cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(() => {
      setLines([...linesRef.current]);
    });
  }, []);

  // Subscribe to session-output events
  useEffect(() => {
    if (!hasSession) return;
    const originalHandler = useContractorStore.getState().handleSessionOutput;
    useContractorStore.setState({
      handleSessionOutput: (data: Record<string, unknown>) => {
        if (data.contract_id === contractId && typeof data.line === 'string') {
          appendLine(data.line);
        }
        originalHandler(data);
      },
    });
    return () => {
      useContractorStore.setState({ handleSessionOutput: originalHandler });
    };
  }, [contractId, hasSession, appendLine]);

  // Auto-scroll
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [lines]);

  if (!hasSession) {
    return null;
  }

  return (
    <div className="border-t border-slate-800 pt-3">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-1.5">
          <Terminal className="w-3.5 h-3.5 text-slate-500" />
          <span className="text-xs font-medium text-slate-400">Session Output</span>
          {lines.length > 0 && (
            <span className="text-[10px] text-slate-600">({lines.length} lines)</span>
          )}
        </div>
        <button
          onClick={() => setExpanded(!expanded)}
          className="text-[10px] text-slate-500 hover:text-slate-300 transition-colors"
        >
          {expanded ? 'Collapse' : 'Expand'}
        </button>
      </div>
      {loading ? (
        <div className="text-xs text-slate-500">Loading...</div>
      ) : lines.length === 0 ? (
        <div className="text-xs text-slate-500">Waiting for output...</div>
      ) : (
        <div
          ref={scrollRef}
          className={`bg-slate-950 rounded border border-slate-800 p-2 overflow-y-auto overflow-x-auto font-mono ${
            expanded ? 'max-h-80' : 'max-h-32'
          }`}
        >
          {lines.map((line, i) => (
            <div key={i} className="text-[10px] text-slate-400 whitespace-pre leading-4">
              {line}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// --- Hire Picker ---

function HirePicker({
  pool,
  loading,
  onClose,
}: {
  pool: ContractorProfile[];
  loading: boolean;
  onClose: () => void;
}) {
  const [search, setSearch] = useState('');

  const filtered = pool.filter(p =>
    p.name.toLowerCase().includes(search.toLowerCase()) ||
    (p.description || '').toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* Header */}
      <div className="px-4 py-2 border-b border-slate-800">
        <div className="flex items-center justify-between mb-2">
          <span className="text-sm font-medium text-slate-200">Hire Contractor</span>
          <button
            onClick={onClose}
            className="text-xs text-slate-400 hover:text-slate-200"
          >
            Cancel
          </button>
        </div>
        <input
          type="text"
          placeholder="Search pool..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="w-full px-2.5 py-1.5 text-sm bg-slate-800 border border-slate-700 rounded text-slate-200 placeholder-slate-500 focus:outline-none focus:border-emerald-500"
          autoFocus
        />
      </div>

      {/* Pool list */}
      <div className="flex-1 overflow-y-auto p-2">
        {loading ? (
          <div className="p-4 text-sm text-slate-500 text-center">Loading pool...</div>
        ) : filtered.length === 0 ? (
          <div className="p-4 text-sm text-slate-500 text-center">
            {search ? 'No matches' : 'No profiles in pool'}
          </div>
        ) : (
          filtered.map(profile => (
            <PoolProfileItem key={profile.name} profile={profile} onClose={onClose} />
          ))
        )}
      </div>
    </div>
  );
}

// --- Pool Profile Item ---

function PoolProfileItem({
  profile,
  onClose,
}: {
  profile: ContractorProfile;
  onClose: () => void;
}) {
  const [hiring, setHiring] = useState(false);
  const [subject, setSubject] = useState('');
  const [showSubject, setShowSubject] = useState(false);
  const [error, setError] = useState('');

  const handleHire = async () => {
    if (!subject.trim()) return;
    setHiring(true);
    setError('');
    try {
      const { agents, activeAgentId } = useAppStore.getState();
      const activeAgent = agents.find(a => a.id === activeAgentId);
      const fromAgent = activeAgent?.name || agents[0]?.name;
      if (!fromAgent) {
        setError('No agent identity available. Open a terminal pane first.');
        setHiring(false);
        return;
      }

      const secret = await window.electronAPI.getLocalSecret();
      const res = await fetch('http://127.0.0.1:3001/v1/mail/send', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(secret ? { 'Authorization': `Bearer ${secret}` } : {}),
        },
        body: JSON.stringify({
          from_agent: fromAgent,
          to: [profile.name],
          subject: subject.trim(),
          body: `Hiring ${profile.name} for: ${subject.trim()}`,
          importance: 'normal',
        }),
      });
      if (res.ok) {
        useContractorStore.getState().fetchActive();
        onClose();
      } else {
        const errBody = await res.json().catch(() => null);
        const serverMsg = errBody?.error?.message || errBody?.message;
        const msg = res.status === 409
          ? serverMsg || 'Max 3 active contracts. Complete or cancel an existing contract first.'
          : serverMsg || `Request failed (${res.status})`;
        setError(msg);
        console.error('[Contractors] Hire failed:', res.status, msg);
      }
    } catch (err) {
      setError('Network error — backend may be unavailable');
      console.error('[Contractors] Hire failed:', err);
    } finally {
      setHiring(false);
    }
  };

  return (
    <div className="p-2 rounded hover:bg-slate-800 transition-colors border border-transparent hover:border-slate-700">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium text-slate-200">{profile.name}</span>
        {!showSubject && (
          <button
            onClick={() => setShowSubject(true)}
            className="text-xs px-2 py-1 rounded bg-emerald-600 hover:bg-emerald-500 text-white transition-colors"
          >
            Hire
          </button>
        )}
      </div>
      {profile.description && (
        <p className="text-xs text-slate-400 mt-0.5">{profile.description}</p>
      )}
      {profile.model && (
        <span className="text-[10px] text-slate-500">Model: {profile.model}</span>
      )}
      {profile.tools && profile.tools.length > 0 && (
        <div className="flex flex-wrap gap-1 mt-1">
          {profile.tools.map(t => (
            <span key={t} className="text-[10px] px-1 py-0.5 rounded bg-slate-800 text-slate-400 border border-slate-700">
              {t}
            </span>
          ))}
        </div>
      )}

      {/* Inline hire form */}
      {showSubject && (
        <div className="mt-2 space-y-1.5">
          <input
            type="text"
            placeholder="Contract subject (what's the task?)"
            value={subject}
            onChange={(e) => { setSubject(e.target.value); setError(''); }}
            className="w-full px-2 py-1.5 text-xs bg-slate-800 border border-slate-700 rounded text-slate-200 placeholder-slate-500 focus:outline-none focus:border-emerald-500"
            autoFocus
            onKeyDown={(e) => { if (e.key === 'Enter') handleHire(); if (e.key === 'Escape') setShowSubject(false); }}
          />
          {error && (
            <div className="text-xs text-red-400 bg-red-900/20 border border-red-800/50 rounded px-2 py-1">
              {error}
            </div>
          )}
          <div className="flex gap-1">
            <button
              onClick={handleHire}
              disabled={hiring || !subject.trim()}
              className="flex-1 text-xs py-1 rounded bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white transition-colors"
            >
              {hiring ? 'Hiring...' : 'Send contract'}
            </button>
            <button
              onClick={() => { setShowSubject(false); setError(''); }}
              className="text-xs py-1 px-2 rounded bg-slate-800 text-slate-400 hover:text-slate-200 transition-colors"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
