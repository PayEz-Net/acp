import { useEffect, useState } from 'react';
import { useAppStore } from '../../stores/appStore';
import { X, Server, Users, Radio, RefreshCw, Bot } from 'lucide-react';

interface SettingsPanelProps {
  isOpen: boolean;
  onClose: () => void;
}

// Agent Provider selection component
function AgentProviderSection() {
  const { settings, setSettings } = useAppStore();
  const [provider, setProvider] = useState(settings.agentProvider || 'kimi');
  const [effort, setEffort] = useState(settings.claudeEffort || 'max');

  const handleProviderChange = async (newProvider: 'claude' | 'kimi') => {
    setProvider(newProvider);
    await window.electronAPI.setSettings({ 
      ...settings, 
      agentProvider: newProvider 
    });
    setSettings({ ...settings, agentProvider: newProvider });
  };

  const handleEffortChange = async (newEffort: 'low' | 'medium' | 'high' | 'max') => {
    setEffort(newEffort);
    await window.electronAPI.setSettings({ 
      ...settings, 
      claudeEffort: newEffort 
    });
    setSettings({ ...settings, claudeEffort: newEffort });
  };

  return (
    <div className="p-4 border-b border-slate-800">
      <h3 className="text-sm font-semibold text-slate-300 flex items-center gap-2 mb-3">
        <Bot className="w-4 h-4" /> AI Provider
      </h3>
      
      {/* Provider Selection */}
      <div className="flex gap-2 mb-3">
        <button
          onClick={() => handleProviderChange('kimi')}
          className={`flex-1 py-2 px-3 text-sm rounded border transition-colors ${
            provider === 'kimi'
              ? 'bg-violet-600 border-violet-500 text-white'
              : 'bg-slate-800 border-slate-700 text-slate-300 hover:bg-slate-700'
          }`}
        >
          Kimi
        </button>
        <button
          onClick={() => handleProviderChange('claude')}
          className={`flex-1 py-2 px-3 text-sm rounded border transition-colors ${
            provider === 'claude'
              ? 'bg-amber-600 border-amber-500 text-white'
              : 'bg-slate-800 border-slate-700 text-slate-300 hover:bg-slate-700'
          }`}
        >
          Claude
        </button>
      </div>

      {/* Claude Effort Level (only shown for Claude) */}
      {provider === 'claude' && (
        <div className="mt-3">
          <label className="text-xs text-slate-400 mb-2 block">Thinking Effort</label>
          <select
            value={effort}
            onChange={(e) => handleEffortChange(e.target.value as 'low' | 'medium' | 'high' | 'max')}
            className="w-full bg-slate-800 border border-slate-700 text-slate-200 text-sm rounded px-3 py-2"
          >
            <option value="low">Low (fastest)</option>
            <option value="medium">Medium</option>
            <option value="high">High (recommended)</option>
            <option value="max">Max (slowest)</option>
          </select>
          <p className="text-xs text-slate-500 mt-1">
            Higher effort = more thorough analysis but slower responses.
          </p>
        </div>
      )}

      {/* Kimi Note */}
      {provider === 'kimi' && (
        <p className="text-xs text-slate-500 mt-2">
          Kimi Code CLI with project-level skills from .agents/skills/
        </p>
      )}
    </div>
  );
}

interface HealthData {
  status: string;
  uptime_seconds?: number;
  version?: string;
  storage?: string;
  response_ms?: number;
}

interface SseStatus {
  [agent: string]: string;
}

export function SettingsPanel({ isOpen, onClose }: SettingsPanelProps) {
  const { backendAvailable, agents } = useAppStore();
  const [health, setHealth] = useState<HealthData | null>(null);
  const [sseStatus, setSseStatus] = useState<SseStatus>({});
  const [loading, setLoading] = useState(false);

  const fetchHealth = async () => {
    if (!backendAvailable) return;
    try {
      const res = await fetch('http://127.0.0.1:3001/health');
      if (res.ok) setHealth(await res.json());
    } catch { /* ignore */ }
  };

  const fetchSseStatus = async () => {
    if (!backendAvailable) return;
    try {
      const secret = await window.electronAPI.getLocalSecret();
      const res = await fetch('http://127.0.0.1:3001/v1/sse/status', {
        headers: secret ? { 'Authorization': `Bearer ${secret}` } : {},
      });
      if (res.ok) {
        const data = await res.json();
        setSseStatus(data.data || data);
      }
    } catch { /* ignore */ }
  };

  useEffect(() => {
    if (!isOpen) return;
    fetchHealth();
    fetchSseStatus();
  }, [isOpen, backendAvailable]);

  if (!isOpen) return null;

  const uptime = health?.uptime_seconds
    ? `${Math.floor(health.uptime_seconds / 60)}m ${Math.floor(health.uptime_seconds % 60)}s`
    : 'N/A';

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-20">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      <div className="relative bg-slate-900 border border-slate-700 rounded-lg shadow-xl w-[420px] max-h-[70vh] overflow-auto">
        <div className="flex items-center justify-between p-4 border-b border-slate-700">
          <span className="text-lg font-semibold text-white">Settings</span>
          <button onClick={onClose} className="text-slate-400 hover:text-white"><X className="w-5 h-5" /></button>
        </div>

        {/* Backend */}
        <div className="p-4 border-b border-slate-800">
          <h3 className="text-sm font-semibold text-slate-300 flex items-center gap-2 mb-3">
            <Server className="w-4 h-4" /> Backend (acp-api)
          </h3>
          <div className="space-y-2 text-sm">
            <div className="flex justify-between">
              <span className="text-slate-400">Status</span>
              <span className={backendAvailable ? 'text-emerald-400' : 'text-red-400'}>
                {backendAvailable ? 'Connected' : 'Disconnected'}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-slate-400">Port</span>
              <span className="text-slate-200">3001</span>
            </div>
            <div className="flex justify-between">
              <span className="text-slate-400">Uptime</span>
              <span className="text-slate-200">{uptime}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-slate-400">Version</span>
              <span className="text-slate-200">{health?.version || 'N/A'}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-slate-400">Storage</span>
              <span className="text-slate-200">{health?.storage || 'N/A'}</span>
            </div>
            {!backendAvailable && (
              <button
                onClick={async () => {
                  setLoading(true);
                  await window.electronAPI.retryBackend();
                  setLoading(false);
                  fetchHealth();
                }}
                disabled={loading}
                className="w-full mt-2 py-2 bg-emerald-600 hover:bg-emerald-500 text-white text-sm rounded flex items-center justify-center gap-2"
              >
                <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} /> Retry Connection
              </button>
            )}
          </div>
        </div>

        {/* Agents */}
        <div className="p-4 border-b border-slate-800">
          <h3 className="text-sm font-semibold text-slate-300 flex items-center gap-2 mb-3">
            <Users className="w-4 h-4" /> Agents
          </h3>
          <div className="space-y-1">
            {agents.map((a) => (
              <div key={a.id} className="flex items-center justify-between text-sm py-1">
                <div className="flex items-center gap-2">
                  <div className="w-2 h-2 rounded-full" style={{ backgroundColor: a.color }} />
                  <span className="text-slate-200">{a.name}</span>
                </div>
                <span className="text-xs text-slate-500 capitalize">{a.status}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Agent Provider */}
        <AgentProviderSection />

        {/* SSE */}
        <div className="p-4">
          <h3 className="text-sm font-semibold text-slate-300 flex items-center gap-2 mb-3">
            <Radio className="w-4 h-4" /> SSE Connections
          </h3>
          <div className="space-y-1">
            {Object.entries(sseStatus).map(([agent, state]) => (
              <div key={agent} className="flex items-center justify-between text-sm py-1">
                <span className="text-slate-200">{agent}</span>
                <span className={`text-xs ${
                  state === 'connected' ? 'text-emerald-400' :
                  state === 'reconnecting' ? 'text-amber-400' :
                  'text-red-400'
                }`}>
                  {state}
                </span>
              </div>
            ))}
            {Object.keys(sseStatus).length === 0 && (
              <div className="text-xs text-slate-500">No SSE data</div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
