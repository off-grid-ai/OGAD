// Composition root for documents (chat attachments and project knowledge bases): the shared ingest
// and turn services (@offgrid/rag/documents) wired to desktop's adapters. No rules live here.

import { BrowserWindow } from 'electron'
import { estimateTextTokens } from '@offgrid/models'
import {
  DocumentIngestService,
  DocumentTurnService,
  type DocumentProgress,
  type DocumentSource,
  type Scheduler
} from '@offgrid/rag/documents'
import { documentExtractor } from './extract'
import { documentKeywordSearch, documentStore } from './sqlite-store'
import { documentEmbedder, documentReranker } from './models'
import { conversationDocuments, referencedDocumentIds } from './conversation-documents'
import { knowledgeBaseDocumentIds, projectDocuments } from './project-documents'
import { pageOcr, shutdownOcr } from './ocr'
import { getDB, tableExists } from '../database'

/** Foreground work (a chat reply, an image, speech) is running or waiting to run. */
async function foregroundBusy(): Promise<boolean> {
  const { modalityQueue } = await import('../modality-queue/queue')
  const { running, queued } = modalityQueue.getState()
  return [...running, ...queued].some((job) => job.tier < 3)
}

/**
 * Background indexing waits while the user is waiting on something, so it never slows an answer.
 * It does not wait for other background passes (ambient capture runs them almost constantly).
 */
const scheduler: Scheduler = {
  async yieldToForeground() {
    while (await foregroundBusy()) await new Promise((resolve) => setTimeout(resolve, 400))
  }
}

const lastSent = new Map<string, { phase: string; at: number }>()

/** Progress to every window, at most a few times a second per document (phase changes always). */
function broadcast(progress: DocumentProgress): void {
  const previous = lastSent.get(progress.id)
  const now = Date.now()
  if (previous && previous.phase === progress.phase && now - previous.at < 250) return
  lastSent.set(progress.id, { phase: progress.phase, at: now })
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send('documents:progress', progress)
  }
}

const warn = (message: string, error: unknown): void => {
  console.warn(`[documents] ${message}:`, error instanceof Error ? error.message : error)
}

export const documentIngest = new DocumentIngestService({
  extract: documentExtractor,
  store: documentStore,
  scheduler,
  embed: documentEmbedder,
  ocr: pageOcr,
  onProgress: broadcast,
  onWarning: warn
})

export const documentTurns = new DocumentTurnService({
  ingest: documentIngest,
  store: documentStore,
  conversations: conversationDocuments,
  projects: projectDocuments,
  keyword: documentKeywordSearch,
  embed: documentEmbedder,
  rerank: documentReranker,
  countTokens: estimateTextTokens,
  onWarning: warn
})

/** Start reading a document right after it is attached; the turn finds it indexed or indexing. */
export function startDocumentIngest(source: DocumentSource): void {
  void documentIngest.ingest(source)
}

/** Unused caches are deleted after this long. */
const CACHE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000

/** Documents a conversation or a knowledge base still uses. */
async function documentsInUse(): Promise<Set<string>> {
  const used = await referencedDocumentIds()
  for (const id of await knowledgeBaseDocumentIds()) used.add(id)
  for (const { document_id } of keptDocumentsTable().prepare('SELECT document_id FROM kept_documents').all() as {
    document_id: string
  }[])
    used.add(document_id)
  return used
}

let keptReady: object | undefined

/** Documents kept by an owner outside chats (a meeting transcript, a long dictation). */
function keptDocumentsTable(): ReturnType<typeof getDB> {
  const db = getDB()
  if (keptReady !== db) {
    db.exec(`CREATE TABLE IF NOT EXISTS kept_documents (
      owner TEXT PRIMARY KEY,
      document_id TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_kept_documents_document ON kept_documents(document_id);`)
    keptReady = db
  }
  return db
}

/** `owner` (e.g. "meeting:12") keeps `documentId`: cache cleanup never drops it while kept. */
export function keepDocument(owner: string, documentId: string): void {
  keptDocumentsTable()
    .prepare('INSERT INTO kept_documents (owner, document_id) VALUES (?, ?) ON CONFLICT(owner) DO UPDATE SET document_id = excluded.document_id')
    .run(owner, documentId)
}

/** `owner` no longer keeps its document; cleanup may drop it when nothing else uses it. */
export function releaseDocument(owner: string): void {
  keptDocumentsTable().prepare('DELETE FROM kept_documents WHERE owner = ?').run(owner)
}

/**
 * Release every document kept by an owner `${prefix}:<id>` whose row in `table` is gone (a
 * privacy clear or retention deleted the rows directly, not through their owner's delete). All of
 * them when the table does not exist. Returns how many were released.
 */
export function releaseDocumentsOfDeletedOwners(prefix: string, table: string): number {
  const db = keptDocumentsTable()
  const owner = `${prefix}:`
  const ownedHere = 'substr(owner, 1, ?) = ?'
  if (!tableExists(db, table)) {
    return db
      .prepare(`DELETE FROM kept_documents WHERE ${ownedHere}`)
      .run(owner.length, owner).changes
  }
  return db
    .prepare(
      `DELETE FROM kept_documents WHERE ${ownedHere}
         AND CAST(substr(owner, ?) AS INTEGER) NOT IN (SELECT id FROM ${table})`
    )
    .run(owner.length, owner, owner.length + 1).changes
}

/** Drop document caches nothing references and that went unused for 30 days. */
export async function collectDocumentGarbage(): Promise<void> {
  try {
    await documentIngest.collectGarbage(await documentsInUse(), CACHE_MAX_AGE_MS)
  } catch (error) {
    warn('Cleaning document caches failed', error)
  }
}

/** Drop documents nothing uses (no chat, knowledge base or owner keeps them), now. Throws on
 *  failure: a privacy delete must not report success while the text remains. */
export async function removeUnreferencedDocuments(): Promise<void> {
  await documentIngest.collectGarbage(await documentsInUse(), 0)
}

/** A conversation or knowledge-base file was deleted: drop documents nothing else uses, now. */
export async function forgetUnreferencedDocuments(): Promise<void> {
  try {
    await removeUnreferencedDocuments()
  } catch (error) {
    warn('Removing documents of a deleted chat failed', error)
  }
}

export async function shutdownDocuments(): Promise<void> {
  documentIngest.shutdown()
  await Promise.all([documentExtractor.shutdown(), shutdownOcr()])
}

export { documentStore }

/**
 * Prompt-reading speed of the local model, measured on real (long) prompts. It sets how much of a
 * document the first answer reads (shared documentBudget). Smoothed, so one slow run does not swing it.
 */
let measuredPrefill: number | undefined

export function noteDocumentPrefill(metrics?: {
  prefillTokensPerSecond?: number
  promptTokens?: number
}): void {
  const rate = metrics?.prefillTokensPerSecond
  // Short prompts measure overhead more than reading speed.
  if (!rate || !Number.isFinite(rate) || (metrics.promptTokens ?? 0) < 1_500) return
  measuredPrefill = measuredPrefill ? measuredPrefill * 0.7 + rate * 0.3 : rate
}

export function documentPrefillRate(): number | undefined {
  return measuredPrefill
}

/** Passages each conversation's last answer used, for follow-ups ("tell me more"). */
const previousSources = new Map<string, string[]>()

export function rememberDocumentSources(conversationId: string | undefined, keys: string[]): void {
  if (!conversationId) return
  previousSources.delete(conversationId)
  previousSources.set(conversationId, keys)
  if (previousSources.size > 50) previousSources.delete(previousSources.keys().next().value!)
}

export function previousDocumentSources(conversationId: string | undefined): string[] | undefined {
  return conversationId ? previousSources.get(conversationId) : undefined
}
