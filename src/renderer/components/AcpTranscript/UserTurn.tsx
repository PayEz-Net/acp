import type { AcpTurn } from '@shared/acpTypes';

interface UserTurnProps {
  turn: AcpTurn;
}

export function UserTurn({ turn }: UserTurnProps) {
  return (
    <div className="flex justify-end py-2" data-testid="user-turn">
      <div className="max-w-[90%] bg-blue-600/20 text-blue-200 rounded px-3 py-2 text-xs font-terminal whitespace-pre-wrap">
        {turn.contentText}
      </div>
    </div>
  );
}
