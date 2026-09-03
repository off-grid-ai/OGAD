// Compatibility adapter for existing Desktop callers. All RAG behavior runs through the global facade.
import { createOffGridApplication, type RagFacade } from '@offgrid/application'
import {
  DEFAULT_RAG_EMBEDDING_DIMENSION,
  type EmbeddingProvider,
  type ExtractionBridges,
  type IndexDocumentParams,
  type IndexResult,
  type RagDocument,
  type SearchResult
} from '@offgrid/rag'
import { desktopModelWorkspace } from '../model-services'
import { embeddings } from '../embeddings'
import { desktopExtraction } from '../rag/extractors'
import { desktopVectorStore, projectExists } from '../rag/store'
import {
  emitKnowledgeDocumentMutation,
  type KnowledgeDocumentSnapshot
} from '../sync-knowledge-document'
import { desktopApplication, startDesktopApplication } from './application'

const embeddingProvider: EmbeddingProvider = {
  dimension: DEFAULT_RAG_EMBEDDING_DIMENSION,
  embed: (text) => embeddings.generateEmbedding(text)
}

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

function forwardLocalMutation(event: Parameters<Parameters<RagFacade['events']>[0]>[0]): void {
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
}

export class DesktopRagService {
  constructor(
    private readonly facade: RagFacade,
    private readonly startApplication: () => Promise<unknown>
  ) {
    facade.events(forwardLocalMutation)
  }

  async ensureReady(): Promise<void> {
    await this.startApplication()
  }

  indexDocument(
    params: IndexDocumentParams & { origin?: 'local' | 'sync' },
    onProgress?: (
      stage: Parameters<NonNullable<Parameters<RagFacade['addDocument']>[1]>>[0]
    ) => void
  ): Promise<IndexResult> {
    return this.facade.addDocument(params, onProgress)
  }

  toggleDocument(
    docId: number,
    enabled: boolean,
    options?: { origin?: 'local' | 'sync' }
  ): Promise<void> {
    return this.facade.setDocumentEnabled(docId, enabled, options)
  }

  deleteDocument(docId: number, options?: { origin?: 'local' | 'sync' }): Promise<void> {
    return this.facade.removeDocument(docId, options)
  }

  listDocuments(projectId: string): Promise<RagDocument[]> {
    return this.facade.listDocuments(projectId)
  }

  searchProject(
    projectId: string,
    query: string,
    options?: { topK?: number; contextLength?: number }
  ): Promise<SearchResult> {
    return this.facade.search(projectId, query, options)
  }

  backfillEmbeddings(projectId: string): Promise<number> {
    return this.facade.backfillEmbeddings(projectId)
  }

  formatForPrompt(result: SearchResult): string {
    return this.facade.formatSearchResult(result)
  }

  getDocument(docId: number): Promise<RagDocument | undefined> {
    return this.facade.document(docId)
  }

  getAllDocumentsForSync(): KnowledgeDocumentSnapshot[] {
    return this.facade.documentsForSync()
  }

  getDocumentBySyncId(syncId: string): Promise<RagDocument | undefined> {
    return this.facade.documentBySyncId(syncId)
  }

  indexSyncedDocument(document: KnowledgeDocumentSnapshot): Promise<number> {
    return this.facade.indexSyncedDocument(document)
  }

  setSyncedDocumentEnabled(syncId: string, enabled: boolean): Promise<void> {
    return this.facade.setSyncedDocumentEnabled(syncId, enabled)
  }

  deleteSyncedDocument(syncId: string): Promise<void> {
    return this.facade.removeSyncedDocument(syncId)
  }
}

export function createDesktopRagService(
  options: { embeddings?: EmbeddingProvider; extraction?: ExtractionBridges } = {}
): DesktopRagService {
  const application = createOffGridApplication({
    models: { workspace: desktopModelWorkspace },
    rag: {
      store: desktopVectorStore,
      embeddings: options.embeddings ?? embeddingProvider,
      extraction: options.extraction ?? desktopExtraction,
      projectExists: async (projectId) => projectExists(projectId)
    }
  })
  return new DesktopRagService(application.rag, () => application.start())
}

export const ragService = new DesktopRagService(desktopApplication.rag, startDesktopApplication)
