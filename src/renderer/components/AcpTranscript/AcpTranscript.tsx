import { useRef, useEffect } from 'react';
import type { AcpTurn } from '@shared/acpTypes';
import { AssistantTurn } from './AssistantTurn';
import { UserTurn } from './UserTurn';
import { ActivityIndicator } from './ActivityIndicator';

interface AcpTranscriptProps {
  turns: AcpTurn[];
  activeTurnId: string | null;
}

export function AcpTranscript({ turns, activeTurnId }: AcpTranscriptProps) {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [turns, activeTurnId]);

  const activeTurn = turns.find((t) => t.id === activeTurnId);

  return (
    <div
      className="flex-1 min-h-0 overflow-y-auto p-2 font-terminal"
      data-testid="acp-transcript"
    >
      {turns.map((turn) =>
        turn.role === 'user' ? (
          <UserTurn key={turn.id} turn={turn} />
        ) : (
          <AssistantTurn key={turn.id} turn={turn} />
        ),
      )}
      {activeTurn && activeTurn.status !== 'done' && activeTurn.status !== 'error' && (
        <ActivityIndicator status={activeTurn.status} />
      )}
      <div ref={bottomRef} />
    </div>
  );
}
