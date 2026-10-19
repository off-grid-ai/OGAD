// Project knowledge bases: which files a project holds, which are used in answers, and how they
// sync. A file is read and indexed exactly as a chat attachment is (files.ts → the document engine
// in documents/*), found by its content hash, and searched with every other document in the chat.

import fs from 'fs'
import path from 'path'
import type { MediaKind, RagDocument } from '@offgrid/rag'
import {
  deleteRagDocument,
  getRagDocument,
  getRagDocumentBySyncId,
  insertRagDocument,
  listAllRagDocuments,
  listRagDocuments,
  projectExists,
  setRagDocumentEnabled,
  setRagDocumentIndexed
} from './store'
import { AUDIO_EXT, IMAGE_EXT, VIDEO_EXT } from '../files-classify'
import { setMissingDocumentIndexer } from '../documents/project-documents'
import {
  emitKnowledgeDocumentMutation,
  type KnowledgeDocumentSnapshot
} from '../sync-knowledge-document'

type SyncOrigin = 'local' | 'sync'

export interface AddKnowledgeFile {
  projectId: string
  path: string
  fileName: string
  size: number
  syncId?: string
  createdAt?: string
  enabled?: boolean
  origin?: SyncOrigin
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

function kindOf(name: string): MediaKind {
  const ext = path.extname(name).slice(1).toLowerCase()
  if (ext === 'pdf' || ext === 'docx') return ext
  if (IMAGE_EXT.includes(ext)) return 'image'
  if (AUDIO_EXT.includes(ext)) return 'audio'
  if (VIDEO_EXT.includes(ext)) return 'video'
  return 'text'
}

/**
 * Read a file into the document index. PDFs, Word and text files are kept by content and read
 * page by page; audio and video are transcribed and images captioned, and that text is indexed.
 */
async function indexFile(
  filePath: string,
  name: string
): Promise<{ documentId: string; kind: MediaKind; path: string }> {
  const { processUploadPath, ingestTextDocument } = await import('../files')
  if (kindOf(name) === 'image') {
    const read = await processUploadPath(filePath, name, { captionImage: true })
    const indexed = await ingestTextDocument(name, 'image', read.text)
    if (!indexed.documentId) throw new Error('No text could be read from this image.')
    return { documentId: indexed.documentId, kind: 'image', path: filePath }
  }
  const read = await processUploadPath(filePath, name)
  if (!read.documentId) throw new Error('No text could be read from this file.')
  return { documentId: read.documentId, kind: read.kind, path: read.path ?? filePath }
}

/** Files being indexed, so a turn does not start the same transcription twice. */
const indexing = new Map<number, Promise<string | null>>()

/** Index a file that joined the knowledge base before files had document ids. */
function indexExisting(document: RagDocument): Promise<string | null> {
  const known = indexing.get(document.id)
  if (known) return known
  const job = (async () => {
    try {
      if (!fs.existsSync(document.path)) return null
      const indexed = await indexFile(document.path, document.name)
      setRagDocumentIndexed(document.id, indexed)
      return indexed.documentId
    } catch (error) {
      console.warn(`[knowledge] could not read ${document.name}:`, (error as Error).message)
      return null
    } finally {
      indexing.delete(document.id)
    }
  })()
  indexing.set(document.id, job)
  return job
}

export const knowledgeBase = {
  listDocuments(projectId: string): RagDocument[] {
    return listRagDocuments(projectId)
  },

  /** Add a file: its row first, so it shows at once, then its text into the document index. */
  async addFile(params: AddKnowledgeFile): Promise<RagDocument> {
    const docId = insertRagDocument({
      projectId: params.projectId,
      name: params.fileName,
      path: params.path,
      size: params.size,
      kind: kindOf(params.fileName),
      ...(params.syncId ? { syncId: params.syncId } : {}),
      ...(params.createdAt ? { createdAt: params.createdAt } : {}),
      ...(params.enabled === false ? { enabled: false } : {})
    })
    try {
      setRagDocumentIndexed(docId, await indexFile(params.path, params.fileName))
    } catch (error) {
      deleteRagDocument(docId)
      throw error
    }
    const document = getRagDocument(docId)!
    if (params.origin !== 'sync') {
      emitKnowledgeDocumentMutation({ kind: 'indexed', document: snapshot(document) })
    }
    return document
  },

  async toggleDocument(
    docId: number,
    enabled: boolean,
    options: { origin?: SyncOrigin } = {}
  ): Promise<void> {
    setRagDocumentEnabled(docId, enabled)
    if (options.origin === 'sync') return
    const document = getRagDocument(docId)
    if (document) emitKnowledgeDocumentMutation({ kind: 'enabled', syncId: document.syncId, enabled })
  },

  async deleteDocument(docId: number, options: { origin?: SyncOrigin } = {}): Promise<void> {
    const document = getRagDocument(docId)
    deleteRagDocument(docId)
    if (document && options.origin !== 'sync') {
      emitKnowledgeDocumentMutation({ kind: 'deleted', syncId: document.syncId })
    }
    const { forgetUnreferencedDocuments } = await import('../documents')
    await forgetUnreferencedDocuments()
  },

  /** A file's document-index id; a file without one is indexed (waited for only when `wait`). */
  async documentIdFor(document: RagDocument, wait: boolean): Promise<string | null> {
    if (document.documentId) return document.documentId
    const job = indexExisting(document)
    return wait ? job : null
  },

  getAllDocumentsForSync(): KnowledgeDocumentSnapshot[] {
    return listAllRagDocuments().map(snapshot)
  },

  getDocumentBySyncId(syncId: string): RagDocument | undefined {
    return getRagDocumentBySyncId(syncId)
  },

  async indexSyncedDocument(document: KnowledgeDocumentSnapshot): Promise<number> {
    const existing = getRagDocumentBySyncId(document.syncId)
    if (existing) {
      if (existing.enabled !== document.enabled) {
        await knowledgeBase.toggleDocument(existing.id, document.enabled, { origin: 'sync' })
      }
      return existing.id
    }
    if (!projectExists(document.projectId)) {
      throw new Error('knowledge document project is not available')
    }
    const added = await knowledgeBase.addFile({
      projectId: document.projectId,
      path: document.filePath,
      fileName: document.name,
      size: document.fileSize,
      syncId: document.syncId,
      createdAt: document.createdAt,
      enabled: document.enabled,
      origin: 'sync'
    })
    return added.id
  },

  async setSyncedDocumentEnabled(syncId: string, enabled: boolean): Promise<void> {
    const document = getRagDocumentBySyncId(syncId)
    if (document) await knowledgeBase.toggleDocument(document.id, enabled, { origin: 'sync' })
  },

  async deleteSyncedDocument(syncId: string): Promise<void> {
    const document = getRagDocumentBySyncId(syncId)
    if (document) await knowledgeBase.deleteDocument(document.id, { origin: 'sync' })
  }
}

setMissingDocumentIndexer((document, wait) => knowledgeBase.documentIdFor(document, wait))

export * from './store'
