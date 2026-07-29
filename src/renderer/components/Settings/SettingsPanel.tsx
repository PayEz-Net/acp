import { useEffect, useState } from 'react';
import { IDP_CLIENT_APP, IDP_CLIENT_APP_HEADER } from '@shared/idp-config';
import { CLAUDE_EFFORTS, CLAUDE_EFFORT_LABELS, type ClaudeEffort } from '@shared/types';
import { useAppStore } from '../../stores/appStore';
import { CODE_PROVIDERS, CodeProvider, PROVIDER_LABELS } from '../../lib/agentProviders';
import { X, Server, Users, Radio, RefreshCw, Bot, Brain } from 'lucide-react';

interface SettingsPanelProps {
  isOpen: boolean;
  onClose: () => void;
}

// Agent Provider selection component
function AgentProviderSection() {
  const { settings, setSettings } = useAppStore();
  const [provider, setProvider] = useState<CodeProvider>(settings.agentProvider || 'kimi');
  const [effort, setEffort] = useState(settings.claudeEffort || 'high');

  const handleProviderChange = async (newProvider: CodeProvider) => {
    setProvider(newProvider);
    await window.electronAPI.setSettings({ 
      ...settings, 
      agentProvider: newProvider 
    });
    setSettings({ ...settings, agentProvider: newProvider });
  };

  const handleEffortChange = async (newEffort: ClaudeEffort) => {
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
        {CODE_PROVIDERS.map((p) => {
          const active = provider === p;
          const activeClasses =
            p === 'claude'
              ? 'bg-amber-600 border-amber-500 text-white'
              : p === 'kimi'
              ? 'bg-violet-600 border-violet-500 text-white'
              : 'bg-cyan-600 border-cyan-500 text-white';
          return (
            <button
              key={p}
              onClick={() => handleProviderChange(p)}
              className={`flex-1 py-2 px-3 text-sm rounded border transition-colors ${
                active
                  ? activeClasses
                  : 'bg-slate-800 border-slate-700 text-slate-300 hover:bg-slate-700'
              }`}
            >
              {PROVIDER_LABELS[p]}
            </button>
          );
        })}
      </div>

      {/* Claude Effort Level (only shown for Claude) */}
      {provider === 'claude' && (
        <div className="mt-3">
          <label className="text-xs text-slate-400 mb-2 block">Thinking Effort</label>
          <select
            value={effort}
            onChange={(e) => handleEffortChange(e.target.value as ClaudeEffort)}
            className="w-full bg-slate-800 border border-slate-700 text-slate-200 text-sm rounded px-3 py-2"
          >
            {/* Enumerated from CLAUDE_EFFORTS so a new level cannot be missing
                here — this list was hand-written and omitted 'xhigh' entirely. */}
            {CLAUDE_EFFORTS.map((level) => (
              <option key={level} value={level}>
                {CLAUDE_EFFORT_LABELS[level]}
              </option>
            ))}
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

// Show/hide thinking blocks in terminal output.
function ThinkingSection() {
  const { settings, setSettings } = useAppStore();
  const [showThinking, setShowThinking] = useState(settings.showThinking !== false);

  const handleChange = async (enabled: boolean) => {
    setShowThinking(enabled);
    const next = { ...settings, showThinking: enabled };
    await window.electronAPI.setSettings(next);
    setSettings(next);
  };

  return (
    <div className="p-4 border-b border-slate-800">
      <h3 className="text-sm font-semibold text-slate-300 flex items-center gap-2 mb-3">
        <Brain className="w-4 h-4" /> Thinking Blocks
      </h3>
      <label className="flex items-center gap-3 cursor-pointer">
        <input
          type="checkbox"
          checked={showThinking}
          onChange={(e) => handleChange(e.target.checked)}
          className="w-4 h-4 rounded border-slate-600 text-emerald-500 bg-slate-800 focus:ring-emerald-500/50"
        />
        <span className="text-sm text-slate-300">Show agent thinking blocks</span>
      </label>
      <p className="text-xs text-slate-500 mt-2">
        When enabled, collapsed thinking blocks appear alongside agent answers.
      </p>
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
      const res = await fetch('http://127.0.0.1:3001/health', {
        headers: { [IDP_CLIENT_APP_HEADER]: IDP_CLIENT_APP },
      });
      if (res.ok) setHealth(await res.json());
    } catch { /* ignore */ }
  };

  const fetchSseStatus = async () => {
    if (!backendAvailable) return;
    try {
      const secret = await window.electronAPI.getLocalSecret();
      const res = await fetch('http://127.0.0.1:3001/v1/sse/status', {
        headers: {
          [IDP_CLIENT_APP_HEADER]: IDP_CLIENT_APP,
          ...(secret ? { 'Authorization': `Bearer ${secret}` } : {}),
        },
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

        {/* Thinking blocks */}
        <ThinkingSection />

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

        {/* Legal links */}
        <div className="mt-6 pt-4 border-t border-slate-700 flex items-center justify-center gap-3 text-xs text-slate-500">
          <button
            type="button"
            onClick={() => window.electronAPI?.openExternal('https://idealvibe.online/privacy')}
            className="hover:text-slate-300 underline"
          >
            Privacy Policy
          </button>
          <span>�</span>
          <button
            type="button"
            onClick={() => window.electronAPI?.openExternal('https://idealvibe.online/terms')}
            className="hover:text-slate-300 underline"
          >
            Terms of Service
          </button>
        </div>
      </div>
    </div>
  );
}
