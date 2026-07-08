import type { AcpTurn } from '@shared/acpTypes';

interface UserTurnProps {
  turn: AcpTurn;
}

export function UserTurn({ turn }: UserTurnProps) {
  return (
    <div
      className="flex flex-col py-0.5 rounded px-1 -mx-1 items-end hover:bg-slate-800/30"
      data-testid="user-turn"
    >
      <div className="flex items-start gap-2 max-w-[90%] justify-end">
        <span className="min-w-0 whitespace-pre-wrap leading-normal rounded px-1.5 py-0.5 overflow-x-auto font-terminal bg-blue-600/20 text-blue-200">
          {turn.contentText}
        </span>
      </div>
    </div>
  );
}
