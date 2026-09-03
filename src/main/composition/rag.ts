import type { RagFacade } from '@offgrid/application'
import type { RagDocument } from '@offgrid/rag'
import {
  emitKnowledgeDocumentMutation,
  type KnowledgeDocumentSnapshot
} from '../sync-knowledge-document'

function snapshot(document: RagDocument): KnowledgeDocumentSnapshot {
  return {
    syncId: document.syncId,
    projectId: document.projectId,
    name: document.name,
    filePath: document.path,
    fileSize: document.size,
    createdAt: document.createdAt,
    enabled: document.enabled
  }
}

/** Translate local RAG events to the current Desktop sync transport adapter. */
export function connectDesktopRagMutations(rag: RagFacade): () => void {
  return rag.events((event) => {
    if (event.type === 'document_indexed' && event.origin === 'local') {
      emitKnowledgeDocumentMutation({ kind: 'indexed', document: snapshot(event.document) })
    } else if (event.type === 'document_enabled' && event.origin === 'local') {
      emitKnowledgeDocumentMutation({
        kind: 'enabled',
        syncId: event.document.syncId,
        enabled: event.enabled
      })
    } else if (event.type === 'document_removed' && event.origin === 'local') {
      emitKnowledgeDocumentMutation({ kind: 'deleted', syncId: event.document.syncId })
    }
  })
}
