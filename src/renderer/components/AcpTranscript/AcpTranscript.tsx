import { useRef, useEffect } from 'react';
import type { AcpTurn, AcpSessionState, AcpWaitState } from '@shared/acpTypes';
import { useAcpSessionStore } from '../../stores/acpSessionStore';
import { AssistantTurn } from './AssistantTurn';
import { UserTurn } from './UserTurn';
import { ActivityIndicator } from './ActivityIndicator';
import { PermissionRequestCard } from './PermissionRequestCard';

interface AcpTranscriptProps {
  turns: AcpTurn[];
  activeTurnId: string | null;
  agent?: string;
  sessionId?: string;
  pendingPermission?: AcpSessionState['pendingPermission'];
  waitState?: AcpWaitState;
  cancelRequested?: boolean;
}

export function AcpTranscript({
  turns,
  activeTurnId,
  agent,
  sessionId,
  pendingPermission: pendingPermissionProp,
  waitState: waitStateProp,
  cancelRequested,
}: AcpTranscriptProps) {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [turns, activeTurnId]);

  const activeTurn = turns.find((t) => t.id === activeTurnId);

  const derivedAgent = agent ?? turns[0]?.agent ?? '';
  const derivedSessionId = sessionId ?? turns[0]?.sessionId ?? '';
  const storePermission = useAcpSessionStore((s) =>
    derivedAgent ? s.sessions.get(derivedAgent)?.pendingPermission : undefined,
  );
  const pendingPermission = pendingPermissionProp ?? storePermission;
  const storeWaitState = useAcpSessionStore((s) =>
    derivedAgent ? s.sessions.get(derivedAgent)?.waitState : undefined,
  );
  const waitState = waitStateProp ?? storeWaitState;

  const handlePermissionResponse = (optionId: string) => {
    if (!derivedAgent || !derivedSessionId || !pendingPermission) return;
    const option = pendingPermission.options.find((o) => o.optionId === optionId);
    if (!option) return;
    // The ACP runtime treats the selected optionId as the authority for the
    // response; the JSON-RPC outcome field is always 'selected'.
    window.electronAPI
      .sendAcpPermissionResponse({
        agent: derivedAgent,
        sessionId: derivedSessionId,
        permissionRequestId: pendingPermission.requestId,
        outcome: 'selected',
        optionId,
      })
      .catch(() => {
        // Errors are surfaced by the runtime via ACP_EVENT error updates.
      });
    useAcpSessionStore.getState().respondPermission(derivedAgent, optionId);
  };

  return (
    <div className="flex-1 min-h-0 min-w-0 overflow-y-auto p-2 font-terminal" data-testid="acp-transcript">
      {turns.map((turn) =>
        turn.role === 'user' ? (
          <UserTurn key={turn.id} turn={turn} />
        ) : (
          <AssistantTurn key={turn.id} turn={turn} />
        ),
      )}

      {pendingPermission && (
        <PermissionRequestCard
          toolCall={pendingPermission.toolCall}
          options={pendingPermission.options}
          onRespond={handlePermissionResponse}
        />
      )}

      {activeTurn && activeTurn.status !== 'done' && activeTurn.status !== 'error' && (
        <ActivityIndicator status={activeTurn.status} waitState={waitState} />
      )}

      {cancelRequested && (
        <div
          className="px-2 py-1 text-xs text-amber-400 bg-amber-400/10 rounded m-2"
          data-testid="acp-stopping-indicator"
        >
          Stopping…
        </div>
      )}

      <div ref={bottomRef} />
    </div>
  );
}
