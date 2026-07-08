import type { AcpTurn } from '@shared/acpTypes';
import { ToolCallCard } from './ToolCallCard';
import { ThinkingBlock } from '../ThinkingBlock';

interface AssistantTurnProps {
  turn: AcpTurn;
}

/**
 * Render an assistant turn: optional thinking block, tool-call cards, and
 * plain pre-wrap answer prose so ACP output formats consistently with the PTY
 * terminal surface.
 */
export function AssistantTurn({ turn }: AssistantTurnProps) {
  const isLive = turn.status !== 'done' && turn.status !== 'error';
  const hasAnswer = turn.contentText.trim().length > 0;
  const hasThinking = turn.thinking.trim().length > 0;

  return (
    <div className="py-2" data-testid="assistant-turn">
      {/* Live kimi acp streams everything through agent_thought_chunk. When there
          is no separate answer content, render the thinking as the main answer. */}
      {hasThinking && hasAnswer && (
        <ThinkingBlock
          content={turn.thinking}
          label={isLive ? 'Thinking' : 'Thought'}
          live={isLive && turn.status === 'thinking'}
          compact
        />
      )}

      {turn.toolCalls.map((toolCall) => (
        <ToolCallCard key={toolCall.toolCallId} toolCall={toolCall} />
      ))}

      {hasAnswer ? (
        <pre className="font-terminal text-slate-200 text-sm leading-normal whitespace-pre-wrap break-words">
          {turn.contentText}
        </pre>
      ) : hasThinking ? (
        <pre className="font-terminal text-slate-200 text-sm leading-normal whitespace-pre-wrap break-words">
          {turn.thinking}
        </pre>
      ) : null}
    </div>
  );
}
