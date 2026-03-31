import { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import {
  Download,
  Copy,
  ExternalLink,
  Edit,
  History,
  X,
  Check,
} from 'lucide-react';
import { cn, formatTimeAgo } from '../../utils';
import type { AgentDocument, DocumentVersion } from '@shared/types';

// Import highlight.js theme (github-dark works well with our slate theme)
import 'highlight.js/styles/github-dark.css';

export interface DocumentViewerProps {
  document: AgentDocument;
  versions?: DocumentVersion[];
  renderMarkdown?: (content: string) => React.ReactNode;
  onEdit?: (document: AgentDocument) => void;
  onDownload?: (document: AgentDocument, format: 'md' | 'pdf') => void;
  onVersionSelect?: (version: DocumentVersion) => void;
  onClose?: () => void;
  showToolbar?: boolean;
  className?: string;
}

const typeColors: Record<string, string> = {
  spec: 'bg-purple-500',
  report: 'bg-blue-500',
  review: 'bg-amber-500',
  plan: 'bg-green-500',
  other: 'bg-slate-500',
};

export function DocumentViewer({
  document,
  versions,
  renderMarkdown,
  onEdit,
  onDownload,
  onVersionSelect,
  onClose,
  showToolbar = true,
  className,
}: DocumentViewerProps) {
  const [showVersions, setShowVersions] = useState(false);
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(document.content_md);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error('Failed to copy:', err);
    }
  };

  const handleOpenNewTab = () => {
    const blob = new Blob([document.content_md], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    window.open(url, '_blank');
  };

  // Default markdown renderer with syntax highlighting
  const defaultRenderer = (content: string) => (
    <div className="prose prose-invert prose-slate max-w-none prose-headings:text-slate-200 prose-p:text-slate-300 prose-a:text-blue-400 prose-strong:text-slate-200 prose-code:text-slate-300 prose-pre:bg-slate-800 prose-pre:border prose-pre:border-slate-700">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeHighlight]}
        components={{
          // Custom code block styling
          pre: ({ children, ...props }) => (
            <pre className="rounded-lg overflow-x-auto" {...props}>
              {children}
            </pre>
          ),
          // Custom inline code styling
          code: ({ className, children, ...props }) => {
            const isInline = !className;
            return isInline ? (
              <code className="px-1.5 py-0.5 bg-slate-800 rounded text-sm" {...props}>
                {children}
              </code>
            ) : (
              <code className={className} {...props}>
                {children}
              </code>
            );
          },
          // Custom checkbox styling for task lists
          input: ({ type, checked, ...props }) => {
            if (type === 'checkbox') {
              return (
                <input
                  type="checkbox"
                  checked={checked}
                  disabled
                  className="mr-2 rounded border-slate-600"
                  {...props}
                />
              );
            }
            return <input type={type} {...props} />;
          },
          // Custom table styling
          table: ({ children, ...props }) => (
            <div className="overflow-x-auto my-4">
              <table className="min-w-full border-collapse border border-slate-700" {...props}>
                {children}
              </table>
            </div>
          ),
          th: ({ children, ...props }) => (
            <th className="px-4 py-2 bg-slate-800 border border-slate-700 text-left text-sm font-semibold text-slate-200" {...props}>
              {children}
            </th>
          ),
          td: ({ children, ...props }) => (
            <td className="px-4 py-2 border border-slate-700 text-sm text-slate-300" {...props}>
              {children}
            </td>
          ),
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );

  const render = renderMarkdown || defaultRenderer;

  return (
    <div
      className={cn(
        'flex flex-col h-full bg-slate-900 border border-slate-700 rounded-lg overflow-hidden',
        className
      )}
    >
      {/* Header */}
      {showToolbar && (
        <div className="flex items-center justify-between px-4 py-3 border-b border-slate-700 bg-slate-800">
          <div className="flex items-center gap-3 min-w-0">
            {/* Type badge */}
            <span
              className={cn(
                'px-2 py-0.5 text-xs font-medium text-white rounded capitalize',
                typeColors[document.type] || typeColors.other
              )}
            >
              {document.type}
            </span>

            {/* Title */}
            <h2 className="font-semibold text-white truncate">{document.title}</h2>

            {/* Version */}
            <span className="text-xs text-slate-400">v{document.version}</span>
          </div>

          {/* Actions */}
          <div className="flex items-center gap-1">
            {/* Copy */}
            <button
              type="button"
              onClick={handleCopy}
              className="p-2 text-slate-400 hover:text-white hover:bg-slate-700 rounded transition-colors"
              title="Copy to clipboard"
              aria-label="Copy document to clipboard"
            >
              {copied ? <Check size={16} className="text-green-500" /> : <Copy size={16} />}
            </button>

            {/* Download */}
            {onDownload && (
              <button
                type="button"
                onClick={() => onDownload(document, 'md')}
                className="p-2 text-slate-400 hover:text-white hover:bg-slate-700 rounded transition-colors"
                title="Download as Markdown"
                aria-label="Download as Markdown"
              >
                <Download size={16} />
              </button>
            )}

            {/* Open in new tab */}
            <button
              type="button"
              onClick={handleOpenNewTab}
              className="p-2 text-slate-400 hover:text-white hover:bg-slate-700 rounded transition-colors"
              title="Open in new tab"
              aria-label="Open document in new tab"
            >
              <ExternalLink size={16} />
            </button>

            {/* Version history */}
            {versions && versions.length > 0 && (
              <button
                type="button"
                onClick={() => setShowVersions(!showVersions)}
                className={cn(
                  'p-2 rounded transition-colors',
                  showVersions
                    ? 'text-blue-400 bg-blue-500/20'
                    : 'text-slate-400 hover:text-white hover:bg-slate-700'
                )}
                title="Version history"
                aria-label="Toggle version history"
                aria-expanded={showVersions}
              >
                <History size={16} />
              </button>
            )}

            {/* Edit */}
            {onEdit && (
              <button
                type="button"
                onClick={() => onEdit(document)}
                className="p-2 text-slate-400 hover:text-white hover:bg-slate-700 rounded transition-colors"
                title="Edit document"
                aria-label="Edit document"
              >
                <Edit size={16} />
              </button>
            )}

            {/* Close */}
            {onClose && (
              <button
                type="button"
                onClick={onClose}
                className="p-2 text-slate-400 hover:text-white hover:bg-slate-700 rounded transition-colors ml-2"
                title="Close"
                aria-label="Close document viewer"
              >
                <X size={16} />
              </button>
            )}
          </div>
        </div>
      )}

      {/* Content area */}
      <div className="flex flex-1 overflow-hidden">
        {/* Main content */}
        <div className="flex-1 overflow-y-auto p-4">
          {render(document.content_md)}
        </div>

        {/* Version history sidebar */}
        {showVersions && versions && versions.length > 0 && (
          <div className="w-64 border-l border-slate-700 bg-slate-800/50 overflow-y-auto">
            <div className="p-3 border-b border-slate-700">
              <h3 className="text-sm font-semibold text-slate-300">Version History</h3>
            </div>
            <div className="p-2 space-y-1">
              {versions.map((version) => (
                <button
                  key={version.id}
                  type="button"
                  onClick={() => onVersionSelect?.(version)}
                  className={cn(
                    'w-full text-left p-2 rounded hover:bg-slate-700 transition-colors',
                    version.version === document.version && 'bg-slate-700'
                  )}
                >
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-medium text-white">
                      v{version.version}
                    </span>
                    <span className="text-xs text-slate-500">
                      {formatTimeAgo(version.created_at)}
                    </span>
                  </div>
                  {version.author_agent && (
                    <span className="text-xs text-slate-400">{version.author_agent}</span>
                  )}
                  {version.change_summary && (
                    <p className="text-xs text-slate-500 mt-1 line-clamp-2">
                      {version.change_summary}
                    </p>
                  )}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Footer: metadata */}
      <div className="flex items-center justify-between px-4 py-2 border-t border-slate-700 bg-slate-800/50 text-xs text-slate-500">
        <span>
          {document.author_agent && `By ${document.author_agent} - `}
          Created {formatTimeAgo(document.created_at)}
          {document.updated_at && ` - Updated ${formatTimeAgo(document.updated_at)}`}
        </span>
        <span>{document.content_md.length.toLocaleString()} characters</span>
      </div>
    </div>
  );
}

export default DocumentViewer;
