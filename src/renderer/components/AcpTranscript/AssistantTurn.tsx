import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import type { AcpTurn } from '@shared/acpTypes';
import { ToolCallCard } from './ToolCallCard';
import { ThinkingBlock } from '../ThinkingBlock';

interface AssistantTurnProps {
  turn: AcpTurn;
}

/**
 * Render an assistant turn: optional thinking block, tool-call cards, and
 * Markdown answer prose styled to match native Kimi conventions.
 */
export function AssistantTurn({ turn }: AssistantTurnProps) {
  const isLive = turn.status !== 'done' && turn.status !== 'error';

  return (
    <div className="py-2" data-testid="assistant-turn">
      {turn.thinking && (
        <ThinkingBlock
          content={turn.thinking}
          label={isLive ? 'Thinking...' : 'Thought'}
          live={isLive && turn.status === 'thinking'}
          compact
        />
      )}

      {turn.toolCalls.map((toolCall) => (
        <ToolCallCard key={toolCall.toolCallId} toolCall={toolCall} />
      ))}

      {turn.contentText && (
        <div className="font-terminal text-slate-300 text-xs leading-relaxed mt-1">
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            rehypePlugins={[rehypeHighlight]}
            components={{
              p: ({ children }) => <p className="mb-1">{children}</p>,
              ul: ({ children }) => <ul className="list-disc list-inside mb-1">{children}</ul>,
              ol: ({ children }) => <ol className="list-decimal list-inside mb-1">{children}</ol>,
              li: ({ children }) => <li className="ml-2">{children}</li>,
              code: ({ className, children }) => {
                const inline = !className;
                return inline ? (
                  <code className="bg-slate-800/60 px-1 rounded">{children}</code>
                ) : (
                  <pre className="bg-slate-900/70 rounded p-2 my-1 overflow-x-auto">
                    <code className={className}>{children}</code>
                  </pre>
                );
              },
            }}
          >
            {turn.contentText}
          </ReactMarkdown>
        </div>
      )}
    </div>
  );
}
