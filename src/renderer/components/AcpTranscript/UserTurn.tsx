import type { AcpTurn, AcpContentBlock } from '@shared/acpTypes';

interface UserTurnProps {
  turn: AcpTurn;
}

const DATA_URI_IMAGE_REGEX = /!\[([^\]]*)\]\((data:image\/[a-zA-Z0-9+.-]+;base64,[A-Za-z0-9+/=]+)\)/g;

function hasImageBlock(content: AcpContentBlock[]): boolean {
  return content.some(
    (block) => block.type === 'content' && block.content.type === 'image',
  );
}

function renderContentTextWithImages(text: string): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  let lastIndex = 0;
  for (const match of text.matchAll(DATA_URI_IMAGE_REGEX)) {
    const [fullMatch, alt, src] = match;
    const index = match.index ?? 0;
    if (index > lastIndex) {
      nodes.push(<span key={`text-${lastIndex}`}>{text.slice(lastIndex, index)}</span>);
    }
    nodes.push(
      <img
        key={`img-${index}`}
        src={src}
        alt={alt || 'Pasted image'}
        className="max-w-xs rounded border border-slate-700"
      />,
    );
    lastIndex = index + fullMatch.length;
  }
  if (lastIndex < text.length) {
    nodes.push(<span key={`text-${lastIndex}`}>{text.slice(lastIndex)}</span>);
  }
  return nodes;
}

function renderContentBlocks(content: AcpContentBlock[]): React.ReactNode[] {
  return content.map((block, idx) => {
    if (block.type === 'content' && block.content.type === 'text') {
      return (
        <span key={idx} className="whitespace-pre-wrap">
          {block.content.text}
        </span>
      );
    }
    if (block.type === 'content' && block.content.type === 'image') {
      return (
        <img
          key={idx}
          src={`data:${block.content.mimeType};base64,${block.content.data}`}
          alt="Pasted image"
          className="max-w-xs rounded border border-slate-700"
        />
      );
    }
    return null;
  });
}

export function UserTurn({ turn }: UserTurnProps) {
  const renderContent = hasImageBlock(turn.content)
    ? renderContentBlocks(turn.content)
    : renderContentTextWithImages(turn.contentText);

  return (
    <div
      className="flex flex-col py-0.5 rounded px-1 items-end hover:bg-slate-800/30"
      data-testid="user-turn"
    >
      <div className="flex flex-col items-end gap-2 max-w-[90%]">
        <span className="min-w-0 whitespace-pre-wrap break-words leading-normal rounded px-2 py-1 font-terminal bg-blue-600/25 text-blue-100 text-sm">
          {renderContent}
        </span>
      </div>
    </div>
  );
}
