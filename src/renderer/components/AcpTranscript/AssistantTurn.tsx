import type { AcpTurn } from '@shared/acpTypes';
import ReactMarkdown from 'react-markdown';
import { filterAcpProse } from '../../lib/acpProseGuard';
import { ToolCallCard } from './ToolCallCard';
import { ThinkingBlock } from '../ThinkingBlock';

interface AssistantTurnProps {
  turn: AcpTurn;
}

function MarkdownProse({ children }: { children: string }) {
  return (
    <div className="prose prose-invert prose-sm max-w-none min-w-0 whitespace-pre-wrap break-words text-slate-200">
      <ReactMarkdown>{children}</ReactMarkdown>
    </div>
  );
}

/**
 * Render an assistant turn: optional thinking block, tool-call cards, and
 * Markdown answer prose so ACP output (which is Markdown-shaped) formats
 * naturally instead of showing raw asterisks/list markers.
 *
 * Thinking is always rendered as a distinct, collapsible block rather than
 * mixed into the main answer prose. This prevents internal reasoning tokens,
 * timing metadata, and mid-word TUI-style wrapping from polluting the
 * readable answer.
 */
export function AssistantTurn({ turn }: AssistantTurnProps) {
  const isLive = turn.status !== 'done' && turn.status !== 'error';
  const hasAnswer = turn.contentText.trim().length > 0;
  const hasThinking = turn.thinking.trim().length > 0;
  const answerText = filterAcpProse(turn.contentText);
  const thinkingText = filterAcpProse(turn.thinking);

  return (
    <div className="py-2" data-testid="assistant-turn">
      {hasThinking && (
        <ThinkingBlock
          content={thinkingText}
          label={isLive ? 'Thinking' : 'Thought'}
          live={isLive && turn.status === 'thinking'}
          compact
          markdown
          defaultExpanded={!hasAnswer}
          previewLines={hasAnswer ? 0 : 2}
        />
      )}

      {turn.toolCalls.map((toolCall) => (
        <ToolCallCard key={toolCall.toolCallId} toolCall={toolCall} />
      ))}

      {answerText.trim().length > 0 && <MarkdownProse>{answerText}</MarkdownProse>}
    </div>
  );
}
