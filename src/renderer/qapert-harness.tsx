import React, { useEffect, useState } from 'react';
import ReactDOM from 'react-dom/client';
import { AcpTranscript } from './components/AcpTranscript/AcpTranscript';
import { useAcpSessionStore } from './stores/acpSessionStore';
import './styles/globals.css';
import fixture from './qapert-regression-fixture.json';

const AGENT = 'Kimi';
const SESSION_ID = 'qapert-regression-session';

function replayFixture() {
  useAcpSessionStore.getState().startUserTurn(AGENT, SESSION_ID, 'Show me formatting edge cases.');
  useAcpSessionStore.getState().startAssistantTurn(AGENT, SESSION_ID);

  for (const msg of fixture) {
    if (msg.method !== 'session/update') continue;
    const update = msg.params?.update;
    if (!update) continue;
    useAcpSessionStore.getState().applyEvent({
      agent: AGENT,
      sessionId: SESSION_ID,
      update: update as any,
    });
  }
}

function Harness() {
  const [ready, setReady] = useState(false);
  const session = useAcpSessionStore((s) => s.sessions.get(AGENT));

  useEffect(() => {
    replayFixture();
    // Allow React to render before signaling screenshot readiness.
    const id = setTimeout(() => setReady(true), 500);
    return () => clearTimeout(id);
  }, []);

  if (!session) return <div className="p-4 text-white">Loading fixture…</div>;

  return (
    <div className="h-screen w-screen bg-acp-bg text-slate-200 p-4 flex flex-col">
      <div className="mb-2 text-xs text-slate-400">
        QAPert regression harness — fac57b0
        {ready && <span data-testid="harness-ready"> — ready</span>}
      </div>
      <div className="flex-1 min-h-0 border border-slate-700 rounded bg-slate-900/50 p-2">
        <AcpTranscript
          turns={session.turns}
          activeTurnId={session.activeTurnId}
          agent={AGENT}
          sessionId={SESSION_ID}
        />
      </div>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Harness />
  </React.StrictMode>,
);
