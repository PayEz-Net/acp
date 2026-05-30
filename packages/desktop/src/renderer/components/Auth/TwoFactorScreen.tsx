import { useState } from 'react';
import { useAuthStore } from '../../stores/authStore';
import { Loader2, Shield, AlertCircle } from 'lucide-react';

export function TwoFactorScreen() {
  const { verify2FA, send2FACode, error, isLoading, available2FAMethods } = useAuthStore();
  const [code, setCode] = useState('');
  const [method, setMethod] = useState<'email' | 'sms'>('email');
  const [codeSent, setCodeSent] = useState(false);

  const handleSendCode = async () => {
    try {
      await send2FACode(method);
      setCodeSent(true);
    } catch {
      // Error in store
    }
  };

  const handleVerify = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await verify2FA(code, method);
    } catch {
      // Error in store
    }
  };

  const methods = available2FAMethods || ['email'];

  return (
    <div className="min-h-screen bg-slate-900 flex items-center justify-center p-4">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-16 h-16 bg-gradient-to-br from-violet-500 to-cyan-500 rounded-2xl mb-4">
            <Shield className="w-8 h-8 text-white" />
          </div>
          <h1 className="text-2xl font-bold text-white">Two-Factor Authentication</h1>
          <p className="text-slate-400 mt-2">Enter the code sent to your {method}</p>
        </div>

        <form onSubmit={handleVerify} className="bg-slate-800 rounded-2xl p-6 border border-slate-700">
          {error && (
            <div className="mb-4 p-3 bg-red-500/10 border border-red-500/30 rounded-lg flex items-center gap-2 text-red-400">
              <AlertCircle className="w-4 h-4 shrink-0" />
              <span className="text-sm">{error}</span>
            </div>
          )}

          {!codeSent ? (
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-slate-300 mb-2">Send code via</label>
                <div className="flex gap-2">
                  {methods.includes('email') && (
                    <button
                      type="button"
                      onClick={() => setMethod('email')}
                      className={`flex-1 py-2 px-4 rounded-lg border transition-colors ${
                        method === 'email'
                          ? 'bg-violet-600 border-violet-500 text-white'
                          : 'bg-slate-900 border-slate-600 text-slate-400 hover:border-slate-500'
                      }`}
                    >
                      Email
                    </button>
                  )}
                  {methods.includes('sms') && (
                    <button
                      type="button"
                      onClick={() => setMethod('sms')}
                      className={`flex-1 py-2 px-4 rounded-lg border transition-colors ${
                        method === 'sms'
                          ? 'bg-violet-600 border-violet-500 text-white'
                          : 'bg-slate-900 border-slate-600 text-slate-400 hover:border-slate-500'
                      }`}
                    >
                      SMS
                    </button>
                  )}
                </div>
              </div>

              <button
                type="button"
                onClick={handleSendCode}
                disabled={isLoading}
                className="w-full py-3 bg-gradient-to-r from-violet-600 to-cyan-600 text-white font-semibold rounded-lg hover:from-violet-500 hover:to-cyan-500 disabled:opacity-50 transition-all flex items-center justify-center gap-2"
              >
                {isLoading ? <Loader2 className="w-5 h-5 animate-spin" /> : null}
                Send Code
              </button>
            </div>
          ) : (
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-slate-300 mb-2">Verification Code</label>
                <input
                  type="text"
                  value={code}
                  onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                  className="w-full px-4 py-3 bg-slate-900 border border-slate-600 rounded-lg text-white text-center text-2xl tracking-widest placeholder-slate-500 focus:outline-none focus:border-violet-500"
                  placeholder="000000"
                  maxLength={6}
                  autoFocus
                />
              </div>

              <button
                type="submit"
                disabled={isLoading || code.length !== 6}
                className="w-full py-3 bg-gradient-to-r from-violet-600 to-cyan-600 text-white font-semibold rounded-lg hover:from-violet-500 hover:to-cyan-500 disabled:opacity-50 transition-all flex items-center justify-center gap-2"
              >
                {isLoading ? <Loader2 className="w-5 h-5 animate-spin" /> : null}
                Verify
              </button>

              <button
                type="button"
                onClick={() => setCodeSent(false)}
                className="w-full py-2 text-slate-400 hover:text-white text-sm transition-colors"
              >
                Send a new code
              </button>
            </div>
          )}
        </form>
      </div>
    </div>
  );
}
