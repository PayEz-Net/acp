import type { AcpTurn, AcpToolCall, AcpContentBlock } from '@shared/acpTypes';
import ReactMarkdown from 'react-markdown';
import { filterAcpProse } from '../../lib/acpProseGuard';
import { ToolCallCard } from './ToolCallCard';
import { ToolCallGroup } from './ToolCallGroup';
import { ThinkingBlock } from '../ThinkingBlock';

interface AssistantTurnProps {
  turn: AcpTurn;
}

export function isShellToolCall(toolCall: AcpToolCall): boolean {
  return toolCall.title.toLowerCase().startsWith('shell');
}

function MarkdownProse({ children }: { children: string }) {
  return (
    <div className="prose prose-invert prose-sm max-w-none min-w-0 whitespace-pre-wrap break-words [&_pre]:whitespace-pre-wrap [&_pre]:break-words text-slate-200">
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
  const hasThinking = turn.thinking.trim().length > 0;
  const answerText = filterAcpProse(turn.contentText);
  const thinkingText = filterAcpProse(turn.thinking);
  const hasAnswer = answerText.trim().length > 0;

  return (
    <div className="py-2" data-testid="assistant-turn">
      {hasThinking && (
        <ThinkingBlock
          content={thinkingText}
          label={isLive ? 'Thinking' : 'Thought'}
          live={isLive && turn.status === 'thinking'}
          compact
          markdown
          defaultExpanded={false}
          previewLines={hasAnswer ? 0 : 4}
        />
      )}

      {(() => {
        const running = turn.toolCalls.filter((t) => t.status === 'in_progress');
        const nonShellRunning = running.filter((t) => !isShellToolCall(t));
        const shellRunning = running.filter((t) => isShellToolCall(t));
        const done = turn.toolCalls.filter((t) => t.status !== 'in_progress');
        const nonShellDone = done.filter((t) => !isShellToolCall(t));
        const shellDone = done.filter((t) => isShellToolCall(t));
        return (
          <>
            {nonShellRunning.map((toolCall) => (
              <ToolCallCard key={toolCall.toolCallId} toolCall={toolCall} />
            ))}
            {shellRunning.map((toolCall) => (
              <ToolCallCard key={toolCall.toolCallId} toolCall={toolCall} />
            ))}
            <ToolCallGroup toolCalls={nonShellDone} />
            <ToolCallGroup toolCalls={shellDone} shell />
          </>
        );
      })()}

      {answerText.trim().length > 0 && <MarkdownProse>{answerText}</MarkdownProse>}

      {/* Show a visible placeholder when the assistant finished the turn but
          produced no message, so it doesn't look like the agent fell asleep. */}
      {!hasThinking && !hasAnswer && turn.toolCalls.length === 0 && turn.status === 'done' && (
        <div className="text-xs text-slate-500 italic px-2 py-1" data-testid="assistant-empty-response">
          (no response)
        </div>
      )}

      {hasImageBlock(turn.content) && (
        <div className="flex flex-col gap-2 mt-2" data-testid="assistant-turn-images">
          {turn.content.map((block, idx) => renderImageBlock(block, idx))}
        </div>
      )}
    </div>
  );
}

function hasImageBlock(content: AcpContentBlock[]): boolean {
  return content.some(
    (block) => block.type === 'content' && block.content.type === 'image',
  );
}

function renderImageBlock(block: AcpContentBlock, idx: number): React.ReactNode {
  if (block.type !== 'content' || block.content.type !== 'image') return null;
  return (
    <img
      key={idx}
      src={`data:${block.content.mimeType};base64,${block.content.data}`}
      alt="Pasted image"
      className="max-w-xs rounded border border-slate-700"
    />
  );
}
