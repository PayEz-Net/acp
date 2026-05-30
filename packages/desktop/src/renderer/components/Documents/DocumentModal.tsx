import { useEffect, useRef } from 'react';
import { useDocumentStore } from '../../stores/documentStore';
import { DocumentViewer } from './DocumentViewer';
import type { AgentDocument, DocumentVersion } from '@shared/types';

export function DocumentModal() {
  const {
    activeDocument,
    documentVersions,
    showViewer,
    closeViewer,
    setActiveDocument,
  } = useDocumentStore();

  const modalRef = useRef<HTMLDivElement>(null);

  // Close on escape key
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && showViewer) {
        closeViewer();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [showViewer, closeViewer]);

  // Close on backdrop click
  const handleBackdropClick = (e: React.MouseEvent) => {
    if (e.target === modalRef.current) {
      closeViewer();
    }
  };

  const handleDownload = (doc: AgentDocument, format: 'md' | 'pdf') => {
    if (format === 'md') {
      const blob = new Blob([doc.content_md], { type: 'text/markdown' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${doc.title.replace(/[^a-z0-9]/gi, '_')}.md`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } else {
      // PDF export would require backend support
      console.log('PDF export not yet implemented');
    }
  };

  const handleVersionSelect = (version: DocumentVersion) => {
    if (activeDocument) {
      // Show the selected version's content
      setActiveDocument({
        ...activeDocument,
        content_md: version.content_md,
        version: version.version,
      });
    }
  };

  if (!showViewer || !activeDocument) {
    return null;
  }

  return (
    <div
      ref={modalRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby="document-modal-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={handleBackdropClick}
    >
      {/* Hidden title for screen readers */}
      <h2 id="document-modal-title" className="sr-only">
        {activeDocument.title}
      </h2>
      <div className="w-[90vw] h-[85vh] max-w-5xl animate-in fade-in zoom-in-95 duration-200">
        <DocumentViewer
          document={activeDocument}
          versions={documentVersions}
          onClose={closeViewer}
          onDownload={handleDownload}
          onVersionSelect={handleVersionSelect}
          showToolbar={true}
          className="shadow-2xl"
        />
      </div>
    </div>
  );
}

export default DocumentModal;
