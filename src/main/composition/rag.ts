// Composition root: the shared RagService over Desktop's SQLite vector store, MiniLM embeddings,
// and the Node/native extraction bridges. The Desktop subclass adds one port concern: every local
// mutation is announced to the sync layer; a mutation that arrived FROM sync is not echoed back.
import { DEFAULT_RAG_EMBEDDING_DIMENSION, RagService } from '@offgrid/rag'
import type {
  EmbeddingProvider,
  ExtractionBridges,
  IndexDocumentParams,
  IndexResult,
  RagDocument
} from '@offgrid/rag'
import { embeddings } from '../embeddings'
import {
  desktopVectorStore,
  getRagDocument,
  getRagDocumentBySyncId,
  listAllRagDocuments,
  projectExists
} from '../rag/store'
import { desktopExtraction } from '../rag/extractors'
import {
  emitKnowledgeDocumentMutation,
  type KnowledgeDocumentSnapshot
} from '../sync-knowledge-document'

const embeddingProvider: EmbeddingProvider = {
  dimension: DEFAULT_RAG_EMBEDDING_DIMENSION,
  embed: (text) => embeddings.generateEmbedding(text)
}

type SyncOrigin = 'local' | 'sync'

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

export class DesktopRagService extends RagService {
  async indexDocument(
    params: IndexDocumentParams & { origin?: SyncOrigin },
    onProgress?: Parameters<RagService['indexDocument']>[1]
  ): Promise<IndexResult> {
    const result = await super.indexDocument(params, onProgress)
    if (params.origin !== 'sync') {
      const document = getRagDocument(result.docId)
      if (document) emitKnowledgeDocumentMutation({ kind: 'indexed', document: snapshot(document) })
    }
    return result
  }

  async toggleDocument(
    docId: number,
    enabled: boolean,
    options: { origin?: SyncOrigin } = {}
  ): Promise<void> {
    await super.toggleDocument(docId, enabled)
    if (options.origin !== 'sync') {
      const document = getRagDocument(docId)
      if (document) {
        emitKnowledgeDocumentMutation({ kind: 'enabled', syncId: document.syncId, enabled })
      }
    }
  }

  async deleteDocument(docId: number, options: { origin?: SyncOrigin } = {}): Promise<void> {
    const document = getRagDocument(docId)
    await super.deleteDocument(docId)
    if (document && options.origin !== 'sync') {
      emitKnowledgeDocumentMutation({ kind: 'deleted', syncId: document.syncId })
    }
  }

  getAllDocumentsForSync(): KnowledgeDocumentSnapshot[] {
    return listAllRagDocuments().map(snapshot)
  }

  async getDocumentBySyncId(syncId: string): Promise<RagDocument | undefined> {
    return getRagDocumentBySyncId(syncId)
  }

  async indexSyncedDocument(document: KnowledgeDocumentSnapshot): Promise<number> {
    const existing = getRagDocumentBySyncId(document.syncId)
    if (existing) {
      if (existing.enabled !== document.enabled) {
        await this.toggleDocument(existing.id, document.enabled, { origin: 'sync' })
      }
      return existing.id
    }
    if (!projectExists(document.projectId)) {
      throw new Error('knowledge document project is not available')
    }
    const result = await this.indexDocument({
      projectId: document.projectId,
      path: document.filePath,
      fileName: document.name,
      size: document.fileSize,
      syncId: document.syncId,
      createdAt: document.createdAt,
      enabled: document.enabled,
      origin: 'sync'
    })
    return result.docId
  }

  async setSyncedDocumentEnabled(syncId: string, enabled: boolean): Promise<void> {
    const document = getRagDocumentBySyncId(syncId)
    if (document) await this.toggleDocument(document.id, enabled, { origin: 'sync' })
  }

  async deleteSyncedDocument(syncId: string): Promise<void> {
    const document = getRagDocumentBySyncId(syncId)
    if (document) await this.deleteDocument(document.id, { origin: 'sync' })
  }
}

export function createDesktopRagService(
  options: { embeddings?: EmbeddingProvider; extraction?: ExtractionBridges } = {}
): DesktopRagService {
  return new DesktopRagService({
    store: desktopVectorStore,
    embeddings: options.embeddings ?? embeddingProvider,
    extraction: options.extraction ?? desktopExtraction
  })
}

export const ragService = createDesktopRagService()
