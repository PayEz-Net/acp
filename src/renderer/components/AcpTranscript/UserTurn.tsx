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
        <span className="min-w-0 whitespace-pre-wrap break-words leading-normal rounded px-2 py-1 font-terminal bg-blue-600/25 text-blue-100 text-sm">
          {turn.contentText}
        </span>
      </div>
    </div>
  );
}
