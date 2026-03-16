import { useState, useMemo } from 'react';
import {
  FileText,
  Search,
  Download,
  Eye,
  Edit,
  ChevronDown,
  Check,
} from 'lucide-react';
import { cn, formatTimeAgo } from '../../utils';
import type { AgentDocument, DocumentType } from '@shared/types';

export interface DocumentListProps {
  documents: AgentDocument[];
  onSelect?: (document: AgentDocument) => void;
  onEdit?: (document: AgentDocument) => void;
  onDownload?: (documents: AgentDocument[]) => void;
  selectedIds?: number[];
  onSelectionChange?: (ids: number[]) => void;
  showSearch?: boolean;
  showFilters?: boolean;
  showBulkActions?: boolean;
  className?: string;
}

const typeConfig: Record<DocumentType, { color: string; label: string }> = {
  spec: { color: 'bg-purple-500', label: 'Spec' },
  report: { color: 'bg-blue-500', label: 'Report' },
  review: { color: 'bg-amber-500', label: 'Review' },
  plan: { color: 'bg-green-500', label: 'Plan' },
  other: { color: 'bg-slate-500', label: 'Other' },
};

const allTypes: DocumentType[] = ['spec', 'report', 'review', 'plan', 'other'];

export function DocumentList({
  documents,
  onSelect,
  onEdit,
  onDownload,
  selectedIds = [],
  onSelectionChange,
  showSearch = true,
  showFilters = true,
  showBulkActions = true,
  className,
}: DocumentListProps) {
  const [searchQuery, setSearchQuery] = useState('');
  const [typeFilter, setTypeFilter] = useState<DocumentType[]>([]);
  const [authorFilter, setAuthorFilter] = useState<string | null>(null);
  const [sortBy, setSortBy] = useState<'date' | 'name' | 'type'>('date');
  const [showTypeDropdown, setShowTypeDropdown] = useState(false);

  // Get unique authors
  const authors = useMemo(() => {
    const uniqueAuthors = new Set<string>();
    documents.forEach((doc) => {
      if (doc.author_agent) uniqueAuthors.add(doc.author_agent);
    });
    return Array.from(uniqueAuthors).sort();
  }, [documents]);

  // Filter and sort documents
  const filteredDocuments = useMemo(() => {
    let result = [...documents];

    // Search filter
    if (searchQuery) {
      const query = searchQuery.toLowerCase();
      result = result.filter(
        (doc) =>
          doc.title.toLowerCase().includes(query) ||
          doc.content_md.toLowerCase().includes(query)
      );
    }

    // Type filter
    if (typeFilter.length > 0) {
      result = result.filter((doc) => typeFilter.includes(doc.type));
    }

    // Author filter
    if (authorFilter) {
      result = result.filter((doc) => doc.author_agent === authorFilter);
    }

    // Sort
    result.sort((a, b) => {
      if (sortBy === 'date') {
        return new Date(b.updated_at || b.created_at).getTime() -
               new Date(a.updated_at || a.created_at).getTime();
      }
      if (sortBy === 'name') {
        return a.title.localeCompare(b.title);
      }
      if (sortBy === 'type') {
        return a.type.localeCompare(b.type);
      }
      return 0;
    });

    return result;
  }, [documents, searchQuery, typeFilter, authorFilter, sortBy]);

  const toggleSelection = (id: number) => {
    if (!onSelectionChange) return;
    if (selectedIds.includes(id)) {
      onSelectionChange(selectedIds.filter((i) => i !== id));
    } else {
      onSelectionChange([...selectedIds, id]);
    }
  };

  const selectAll = () => {
    if (!onSelectionChange) return;
    onSelectionChange(filteredDocuments.map((d) => d.id));
  };

  const clearSelection = () => {
    onSelectionChange?.([]);
  };

  const toggleTypeFilter = (type: DocumentType) => {
    if (typeFilter.includes(type)) {
      setTypeFilter(typeFilter.filter((t) => t !== type));
    } else {
      setTypeFilter([...typeFilter, type]);
    }
  };

  return (
    <div className={cn('flex flex-col bg-slate-900 rounded-lg border border-slate-700', className)}>
      {/* Header: Search + Filters */}
      {(showSearch || showFilters) && (
        <div className="p-3 border-b border-slate-700 space-y-3">
          {/* Search */}
          {showSearch && (
            <div className="relative">
              <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
              <input
                type="text"
                placeholder="Search documents..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full pl-9 pr-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-sm text-white placeholder-slate-500 focus:outline-none focus:border-blue-500"
              />
            </div>
          )}

          {/* Filters */}
          {showFilters && (
            <div className="flex items-center gap-2 flex-wrap">
              {/* Type filter dropdown */}
              <div className="relative">
                <button
                  type="button"
                  onClick={() => setShowTypeDropdown(!showTypeDropdown)}
                  className={cn(
                    'flex items-center gap-1 px-3 py-1.5 text-sm rounded-lg border transition-colors',
                    typeFilter.length > 0
                      ? 'bg-blue-500/20 border-blue-500/50 text-blue-400'
                      : 'bg-slate-800 border-slate-700 text-slate-400 hover:text-white'
                  )}
                >
                  <span>Type{typeFilter.length > 0 && ` (${typeFilter.length})`}</span>
                  <ChevronDown size={14} />
                </button>

                {showTypeDropdown && (
                  <div className="absolute top-full left-0 mt-1 w-40 bg-slate-800 border border-slate-700 rounded-lg shadow-xl z-10 py-1">
                    {allTypes.map((type) => (
                      <button
                        key={type}
                        type="button"
                        onClick={() => toggleTypeFilter(type)}
                        className="w-full flex items-center justify-between px-3 py-1.5 text-sm hover:bg-slate-700 transition-colors"
                      >
                        <span className="flex items-center gap-2">
                          <span className={cn('w-2 h-2 rounded-full', typeConfig[type].color)} />
                          <span className="text-slate-300">{typeConfig[type].label}</span>
                        </span>
                        {typeFilter.includes(type) && <Check size={14} className="text-blue-400" />}
                      </button>
                    ))}
                  </div>
                )}
              </div>

              {/* Author filter */}
              {authors.length > 0 && (
                <select
                  value={authorFilter || ''}
                  onChange={(e) => setAuthorFilter(e.target.value || null)}
                  className="px-3 py-1.5 text-sm bg-slate-800 border border-slate-700 rounded-lg text-slate-400 focus:outline-none focus:border-blue-500"
                >
                  <option value="">All Authors</option>
                  {authors.map((author) => (
                    <option key={author} value={author}>{author}</option>
                  ))}
                </select>
              )}

              {/* Sort */}
              <select
                value={sortBy}
                onChange={(e) => setSortBy(e.target.value as typeof sortBy)}
                className="px-3 py-1.5 text-sm bg-slate-800 border border-slate-700 rounded-lg text-slate-400 focus:outline-none focus:border-blue-500"
              >
                <option value="date">Sort by Date</option>
                <option value="name">Sort by Name</option>
                <option value="type">Sort by Type</option>
              </select>
            </div>
          )}
        </div>
      )}

      {/* Bulk actions */}
      {showBulkActions && selectedIds.length > 0 && (
        <div className="flex items-center justify-between px-3 py-2 bg-blue-500/10 border-b border-blue-500/20">
          <span className="text-sm text-blue-400">
            {selectedIds.length} selected
          </span>
          <div className="flex items-center gap-2">
            {onDownload && (
              <button
                type="button"
                onClick={() => {
                  const selected = documents.filter((d) => selectedIds.includes(d.id));
                  onDownload(selected);
                }}
                className="flex items-center gap-1 px-2 py-1 text-sm text-blue-400 hover:text-blue-300 transition-colors"
              >
                <Download size={14} />
                Download
              </button>
            )}
            <button
              type="button"
              onClick={clearSelection}
              className="text-sm text-slate-400 hover:text-white transition-colors"
            >
              Clear
            </button>
          </div>
        </div>
      )}

      {/* Document list — card layout for sidebar */}
      <div className="flex-1 overflow-y-auto divide-y divide-slate-700/50">
        {filteredDocuments.length === 0 ? (
          <div className="flex items-center justify-center h-32 text-sm text-slate-500">
            No documents found
          </div>
        ) : (
          filteredDocuments.map((doc) => (
            <div
              key={doc.id}
              className="group px-3 py-2.5 hover:bg-slate-800/50 cursor-pointer transition-colors"
              onClick={() => onSelect?.(doc)}
            >
              <div className="flex items-start gap-2">
                {onSelectionChange && (
                  <input
                    type="checkbox"
                    checked={selectedIds.includes(doc.id)}
                    onChange={(e) => { e.stopPropagation(); toggleSelection(doc.id); }}
                    className="mt-0.5 rounded border-slate-600 bg-slate-700 text-blue-500 focus:ring-blue-500"
                    aria-label={`Select ${doc.title}`}
                  />
                )}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm text-white truncate">{doc.title}</span>
                  </div>
                  <div className="flex items-center gap-2 mt-1">
                    <span className={cn('px-1.5 py-0.5 text-[10px] font-medium text-white rounded capitalize', typeConfig[doc.type]?.color || typeConfig.other.color)}>
                      {doc.type}
                    </span>
                    <span className="text-xs text-slate-500">{doc.author_agent || '-'}</span>
                    <span className="text-xs text-slate-600">v{doc.version}</span>
                    <span className="text-xs text-slate-600 ml-auto">{formatTimeAgo(doc.updated_at || doc.created_at)}</span>
                  </div>
                </div>
              </div>
            </div>
          ))
        )}
      </div>

      {/* Footer: count */}
      <div className="px-3 py-2 border-t border-slate-700 text-xs text-slate-500">
        {filteredDocuments.length} of {documents.length} documents
      </div>
    </div>
  );
}

export default DocumentList;
