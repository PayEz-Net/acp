import { Bot, X, BookOpen } from 'lucide-react';

interface WelcomeModalProps {
  onDismiss: () => void;
}

const DOCS_URL = 'https://idealvibe.online/acp/docs#quickreference';

// One frame: point at the docs, get out of the way. (Was a 4-step tour
// that provided no value and — via the store getSettings() whitelist bug
// dropping hasSeenWelcome — never stayed dismissed.)
export function WelcomeModal({ onDismiss }: WelcomeModalProps) {
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70">
      <div className="w-[24rem] bg-slate-900 border border-slate-700 rounded-xl shadow-2xl overflow-hidden">
        <div className="px-5 py-4 border-b border-slate-700 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Bot className="w-5 h-5 text-vibe-500" />
            <span className="text-sm font-semibold text-slate-200">ACP</span>
          </div>
          <button
            onClick={onDismiss}
            className="p-1 text-slate-500 hover:text-slate-200 transition-colors"
            title="Dismiss"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="px-6 py-7 text-center">
          <div className="w-12 h-12 rounded-full bg-slate-800 border border-slate-700 flex items-center justify-center mx-auto mb-4">
            <BookOpen className="w-6 h-6 text-vibe-500" />
          </div>
          <h2 className="text-lg font-semibold text-slate-100 mb-2">Read the docs</h2>
          <p className="text-sm text-slate-400 leading-relaxed">
            Everything you need to run your agent team is in the ACP quick
            reference. A few minutes there will save you a lot of time.
          </p>
        </div>

        <div className="border-t border-slate-700 px-4 py-3 flex items-center justify-between">
          <button
            onClick={onDismiss}
            className="text-xs text-slate-500 hover:text-slate-300 transition-colors"
          >
            Dismiss
          </button>
          <button
            onClick={() => {
              window.electronAPI.openOAuthUrl(DOCS_URL);
              onDismiss();
            }}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-medium transition-colors"
          >
            <BookOpen className="w-3.5 h-3.5" />
            Open docs
          </button>
        </div>
      </div>
    </div>
  );
}
