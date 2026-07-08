import type { AcpTurn } from '@shared/acpTypes';
import ReactMarkdown from 'react-markdown';
import { ToolCallCard } from './ToolCallCard';
import { ThinkingBlock } from '../ThinkingBlock';

interface AssistantTurnProps {
  turn: AcpTurn;
}

function MarkdownProse({ children }: { children: string }) {
  return (
    <div className="prose prose-invert prose-sm max-w-none break-words text-slate-200">
      <ReactMarkdown>{children}</ReactMarkdown>
    </div>
  );
}

/**
 * Render an assistant turn: optional thinking block, tool-call cards, and
 * Markdown answer prose so ACP output (which is Markdown-shaped) formats
 * naturally instead of showing raw asterisks/list markers.
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
          markdown
        />
      )}

      {turn.toolCalls.map((toolCall) => (
        <ToolCallCard key={toolCall.toolCallId} toolCall={toolCall} />
      ))}

      {hasAnswer ? (
        <MarkdownProse>{turn.contentText}</MarkdownProse>
      ) : hasThinking ? (
        <MarkdownProse>{turn.thinking}</MarkdownProse>
      ) : null}
    </div>
  );
}
