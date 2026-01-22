import { FileText, RefreshCw, X } from 'lucide-react';
import { useDocumentStore } from '../../stores/documentStore';
import { DocumentList } from './DocumentList';
import type { AgentDocument } from '@shared/types';

interface DocumentSidebarProps {
  isOpen: boolean;
  onClose: () => void;
}

export function DocumentSidebar({ isOpen, onClose }: DocumentSidebarProps) {
  const {
    documents,
    loading,
    openViewer,
  } = useDocumentStore();

  const handleSelect = (document: AgentDocument) => {
    openViewer(document);
  };

  const handleDownload = (docs: AgentDocument[]) => {
    // Download as markdown files
    docs.forEach((doc) => {
      const blob = new Blob([doc.content_md], { type: 'text/markdown' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${doc.title.replace(/[^a-z0-9]/gi, '_')}.md`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    });
  };

  const handleRefresh = () => {
    // TODO: Fetch from backend when ready
    console.log('Refresh documents - backend not ready');
  };

  if (!isOpen) return null;

  return (
    <div className="flex flex-col h-full w-80 bg-slate-900 border-l border-slate-700">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-slate-700">
        <div className="flex items-center gap-2">
          <FileText className="w-5 h-5 text-blue-400" />
          <span className="text-sm font-semibold text-slate-200">Documents</span>
          <span className="px-1.5 py-0.5 text-xs font-medium bg-slate-700 text-slate-300 rounded">
            {documents.length}
          </span>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={handleRefresh}
            disabled={loading}
            className="p-1.5 text-slate-400 hover:text-slate-200 hover:bg-slate-800 rounded transition-colors disabled:opacity-50"
            title="Refresh"
            aria-label="Refresh documents"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          </button>
          <button
            onClick={onClose}
            className="p-1.5 text-slate-400 hover:text-slate-200 hover:bg-slate-800 rounded transition-colors"
            title="Close"
            aria-label="Close documents sidebar"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Document List */}
      <div className="flex-1 overflow-hidden">
        <DocumentList
          documents={documents}
          onSelect={handleSelect}
          onDownload={handleDownload}
          showSearch={true}
          showFilters={true}
          showBulkActions={false}
          className="h-full"
        />
      </div>
    </div>
  );
}

export default DocumentSidebar;
