import { useState, useEffect } from 'react';
import { X, Send, Loader2 } from 'lucide-react';
import { MailMessage } from '@shared/types';

interface ComposeModalProps {
  fromAgent: string;
  replyTo?: MailMessage | null;
  agents: string[];
  onSend: (to: string, subject: string, body: string) => Promise<boolean>;
  onClose: () => void;
}

export function ComposeModal({
  fromAgent,
  replyTo,
  agents,
  onSend,
  onClose,
}: ComposeModalProps) {
  const [to, setTo] = useState(replyTo?.from_agent || '');
  const [subject, setSubject] = useState(
    replyTo ? `RE: ${replyTo.subject.replace(/^RE:\s*/i, '')}` : ''
  );
  const [body, setBody] = useState('');
  const [sending, setSending] = useState(false);

  const availableRecipients = agents.filter((a) => a !== fromAgent);

  // Escape key closes modal
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [onClose]);

  const handleSend = async () => {
    if (!to || !subject.trim() || !body.trim()) return;

    setSending(true);
    const success = await onSend(to, subject, body);
    setSending(false);

    if (success) {
      onClose();
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm" onClick={onClose}>
      <div className="bg-slate-900 border border-slate-700 rounded-xl shadow-xl w-full max-w-lg mx-4" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-slate-700">
          <h3 className="text-sm font-semibold text-slate-200">
            {replyTo ? 'Reply' : 'New Message'}
          </h3>
          <button
            onClick={onClose}
            className="p-1 text-slate-400 hover:text-slate-200 hover:bg-slate-800 rounded transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Form */}
        <div className="p-4 space-y-4">
          {/* From (display only) */}
          <div>
            <label className="text-xs text-slate-500 block mb-1">From</label>
            <div className="px-3 py-2 bg-slate-800 rounded-lg text-sm text-slate-300">
              {fromAgent}
            </div>
          </div>

          {/* To */}
          <div>
            <label className="text-xs text-slate-500 block mb-1">To</label>
            <select
              value={to}
              onChange={(e) => setTo(e.target.value)}
              className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-sm text-slate-200 focus:outline-none focus:border-violet-500"
            >
              <option value="">Select recipient...</option>
              {availableRecipients.map((agent) => (
                <option key={agent} value={agent}>
                  {agent}
                </option>
              ))}
            </select>
          </div>

          {/* Subject */}
          <div>
            <label className="text-xs text-slate-500 block mb-1">Subject</label>
            <input
              type="text"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              placeholder="Subject..."
              className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-sm text-slate-200 placeholder-slate-500 focus:outline-none focus:border-violet-500"
            />
          </div>

          {/* Body */}
          <div>
            <label className="text-xs text-slate-500 block mb-1">Message</label>
            <textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              placeholder="Write your message..."
              rows={6}
              className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-sm text-slate-200 placeholder-slate-500 focus:outline-none focus:border-violet-500 resize-none"
            />
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-slate-700">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm text-slate-400 hover:text-slate-200 transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleSend}
            disabled={!to || !subject.trim() || !body.trim() || sending}
            className="flex items-center gap-2 px-4 py-2 bg-violet-600 hover:bg-violet-500 disabled:bg-slate-700 disabled:text-slate-500 text-white text-sm font-medium rounded-lg transition-colors"
          >
            {sending ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Send className="w-4 h-4" />
            )}
            Send
          </button>
        </div>
      </div>
    </div>
  );
}
