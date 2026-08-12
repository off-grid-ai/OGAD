// Assembles the desktop RAG: the shared RagService over the better-sqlite3
// store, MiniLM embeddings, and the Node/native extraction bridges. Project chat
// runs through the main rag_conversations path (ipc.ts); the old project_threads
// backend was removed as dead code.

import { RagService } from '@offgrid/rag'
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
} from './store'
import { desktopExtraction } from './extractors'
import {
  emitKnowledgeDocumentMutation,
  type KnowledgeDocumentSnapshot
} from '../sync-knowledge-document'

const embeddingProvider: EmbeddingProvider = {
  dimension: 384,
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

  getDocumentBySyncId(syncId: string): RagDocument | undefined {
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
    extraction: options.extraction ?? desktopExtraction,
    chunkOptions: { chunkSize: 600, overlap: 120, minChunkLength: 20 }
  })
}

export const ragService = createDesktopRagService()

export * from './store'
