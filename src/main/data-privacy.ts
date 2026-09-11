// One place to see and delete on-device data. Local-first: this is the user's
// data on their machine, so deletion is real and immediate (SQLite rows + the
// data directories). Models are intentionally NOT included here — they're managed
// (with sizes) in the Storage panel, and re-downloading is expensive.
import fs from 'fs'
import path from 'path'
import { workflowFailureMessage, type WorkspaceContentSnapshot } from '@offgrid/application'
import { app } from 'electron'
import { desktopWorkflows, desktopWorkspaceContent } from './composition/application-access'
import { getDB } from './database'
import * as galleryPrivacy from './imagegen/gallery-privacy'
import { deleteByKinds, deleteByKindsOlderThan, resetVectors } from './vectors'
import {
  clearDirs,
  clearDirsOlderThan,
  clearFiles,
  dirSize,
  isMissingPath
} from './data-privacy-files'
import {
  advancePrivacyPublicationIntent,
  completePrivacyPublicationIntent,
  pendingPrivacyPublicationIntent,
  preparePrivacyPublicationIntent
} from './data-privacy-publication-intent'
import { withDeletionGuards } from './data-deletion-guards'
export {
  registerDataDeletionGuard,
  type DataDeletionContext,
  type DataDeletionGuard,
  type DataDeletionScope
} from './data-deletion-guards'
export { pendingWorkspacePrivacyTargets } from './data-privacy-publication-intent'

export interface DataCategory {
  id: 'chats' | 'memories' | 'captures' | 'meetings' | 'images'
  label: string
  detail: string
  count?: number
  bytes?: number
}

const ud = (...p: string[]): string => path.join(app.getPath('userData'), ...p)
const isMissingTable = (error: unknown): boolean =>
  error instanceof Error && /no such table:/i.test(error.message)

function tableCount(table: string, where = ''): number {
  try {
    return (getDB().prepare(`SELECT COUNT(*) AS c FROM ${table} ${where}`).get() as { c: number }).c
  } catch (error) {
    if (isMissingTable(error)) return 0
    throw error
  }
}

function clearTables(...tables: string[]): void {
  const db = getDB()
  for (const t of tables) {
    try {
      db.prepare(`DELETE FROM ${t}`).run()
    } catch (error) {
      if (!isMissingTable(error)) throw error
    }
  }
}

// The `meetings` table is written by Pro (data-privacy is core), so we can't own
// its schema — but it lives in the same DB. After deleting meeting media we drop
// any row whose audio file is now gone, so the Meetings list never shows ghost
// rows that 404 on play. Unit-agnostic (works for full clear + age-based prune).
// Guarded: in the free build there's no meetings table, so this no-ops.
function pruneDanglingMeetings(): void {
  try {
    const db = getDB()
    const rows = db.prepare('SELECT id, audio_path FROM meetings').all() as {
      id: number
      audio_path: string | null
    }[]
    const del = db.prepare('DELETE FROM meetings WHERE id = ?')
    for (const r of rows) {
      if (!r.audio_path || !fs.existsSync(r.audio_path)) del.run(r.id)
    }
  } catch (error) {
    if (!isMissingTable(error)) throw error
  }
}

// These tables are retained only as legacy upgrade sources. Workspace Content is the live owner.
const LEGACY_CHAT_UPGRADE_TABLES = [
  'conversations',
  'messages',
  'rag_conversations',
  'rag_messages',
  'chat_summaries'
]
const MEMORY_TABLES = [
  'memories',
  'master_memory',
  'entities',
  'entity_edges',
  'entity_facts',
  'entity_sessions'
]

// The SINGLE source of truth for a FULL erase ("Delete all my data"): every store
// that holds personal data. deleteAllData iterates this — so a new personal table
// or directory is erased by REGISTERING it here (or, for a pro feature, via
// registerPersonalStore from pro's activateMain), never by editing deleteAllData.
// This is the fix for the drift that let observations/connectors/secrets/RAG docs
// survive a "full erase": the delete-all set is derived, not a hand-maintained
// subset. Categories keep their own mapping above (clearCategory/getDataSummary);
// this set is a superset of them plus the stores that have no UI category.
interface PersonalStore {
  tables?: string[]
  dirs?: string[]
  files?: string[]
  /** Drop live handles before their durable files are removed. */
  beforeDelete?: () => void
}
const CORE_PERSONAL: PersonalStore[] = [
  { tables: LEGACY_CHAT_UPGRADE_TABLES, dirs: ['uploads'] },
  { tables: MEMORY_TABLES, dirs: ['entity-photos'] },
  // Project metadata + knowledge base. Children precede parents so deletion also
  // works when SQLite foreign-key enforcement is enabled.
  { tables: ['rag_chunks', 'rag_documents', 'projects'], dirs: [] },
  { tables: ['connectors', 'secrets'], dirs: [] }, // MCP integrations + their OAuth tokens (must not survive a wipe)
  { tables: ['user_profile'], dirs: [] },
  { tables: ['backup_restore_intents'], dirs: ['restored-backups'] },
  { tables: ['workspace_content_project_deletion_intents'] },
  { tables: ['workspace_content_conversation_deletion_intents'] },
  { tables: ['generated_image_creation_intents'] },
  { tables: ['workspace_content_local_resource_releases'] },
  { tables: ['generated_image_publication_intents', 'generated_image_publication_receipts'] },
  { tables: [], dirs: ['captures'] },
  { tables: [], dirs: ['meetings'] },
  { tables: [], dirs: ['generated-images', 'artifacts-library', 'style-thumbs'] }
]
const personalStores: PersonalStore[] = [...CORE_PERSONAL]

type FullDeletePhase = 'canonical_content' | 'legacy_cleanup'
let deletionQueue: Promise<void> = Promise.resolve()

function enqueueDeletion<Result>(operation: () => Promise<Result>): Promise<Result> {
  const result = deletionQueue.then(operation)
  deletionQueue = result.then(
    () => undefined,
    () => undefined
  )
  return result
}

type CategoryCleaner = (context: { olderThanDays?: number }) => void | Promise<void>
const categoryCleaners = new Map<DataCategory['id'], Map<string, CategoryCleaner>>()

/** Extend a core privacy category without leaking feature-specific storage names into core.
 * Owners are stable identities, so repeated activation replaces the same registration instead
 * of running destructive cleanup twice. */
export function registerCategoryCleaner(
  category: DataCategory['id'],
  owner: string,
  cleaner: CategoryCleaner
): () => void {
  const cleaners = categoryCleaners.get(category) ?? new Map<string, CategoryCleaner>()
  cleaners.set(owner, cleaner)
  categoryCleaners.set(category, cleaners)
  return () => {
    const current = categoryCleaners.get(category)
    current?.delete(owner)
    if (current?.size === 0) categoryCleaners.delete(category)
  }
}

/** Register a personal-data store (tables + userData-relative dirs) so a FULL erase
 *  clears it too. Called from pro's activateMain for pro-only tables (observations,
 *  entity_aliases, secretary_prefs, action_items, clipboard_items, day_journals, …)
 *  so their names never leak into core source, yet delete-all still wipes them. */
export function registerPersonalStore(store: PersonalStore): void {
  personalStores.push(store)
}

function readyWorkspaceContent(): WorkspaceContentSnapshot {
  const snapshot = desktopWorkspaceContent.snapshot()
  if (snapshot.status !== 'ready') {
    throw new Error('Workspace Content is not ready. Chat data was not changed.')
  }
  return snapshot
}

async function clearCanonicalChats(): Promise<void> {
  const conversations = [...readyWorkspaceContent().conversations].sort((left, right) =>
    left.id.localeCompare(right.id)
  )
  for (const conversation of conversations) {
    const outcome = await desktopWorkflows.deleteConversation(conversation.id)
    if (!outcome.ok) throw new Error(workflowFailureMessage(outcome.failure))
  }
  confirmCanonicalChatsSettled()
  clearTables('workspace_content_conversation_deletion_intents')
}

function confirmCanonicalChatsSettled(): void {
  const { conversations, messages, chatTurns } = readyWorkspaceContent()
  if ([conversations, messages, chatTurns].some((records) => records.length > 0)) {
    throw new Error('Canonical chat data is not empty.')
  }
  assertTableEmpty('generated_image_byte_deletions', 'Image byte deletion work is not settled.')
  assertTableEmpty(
    'generated_image_gallery_state, json_each(generated_image_gallery_state.images_json)',
    'Generated-image gallery deletion work is not settled.',
    "WHERE json_extract(json_each.value, '$.conversationId') IS NOT NULL"
  )
  assertTableEmpty(
    'workspace_content_conversation_deletion_intents',
    'Conversation deletion recovery work is not settled.',
    "WHERE state <> 'completed'"
  )
}

function assertTableEmpty(table: string, message: string, where = ''): void {
  if (tableCount(table, where) !== 0) throw new Error(message)
}

async function clearCanonicalWorkspaceContent(): Promise<void> {
  const projects = [...readyWorkspaceContent().projects].sort((left, right) =>
    left.id.localeCompare(right.id)
  )
  for (const project of projects) {
    const outcome = await desktopWorkflows.deleteProject(project.id)
    if (!outcome.ok) throw new Error(workflowFailureMessage(outcome.failure))
  }

  await clearCanonicalChats()
  await galleryPrivacy.clearDesktopGeneratedImageGallery()
  const remaining = readyWorkspaceContent()
  if (
    remaining.projects.length > 0 ||
    remaining.conversations.length > 0 ||
    remaining.messages.length > 0 ||
    remaining.chatTurns.length > 0
  ) {
    throw new Error('Workspace Content changed during deletion. Legacy data was not removed.')
  }
}

function ensureFullDeleteIntentTable(): void {
  getDB().exec(`CREATE TABLE IF NOT EXISTS data_privacy_delete_all_intent (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    phase TEXT NOT NULL CHECK (phase IN ('canonical_content', 'legacy_cleanup')),
    updated_at TEXT NOT NULL
  )`)
}

export function readFullDeletePhase(): FullDeletePhase | null {
  ensureFullDeleteIntentTable()
  const row = getDB()
    .prepare('SELECT phase FROM data_privacy_delete_all_intent WHERE id = 1')
    .get() as { phase: FullDeletePhase } | undefined
  return row?.phase ?? null
}

async function saveFullDeletePhase(phase: FullDeletePhase): Promise<void> {
  ensureFullDeleteIntentTable()
  getDB()
    .prepare(
      `INSERT INTO data_privacy_delete_all_intent (id, phase, updated_at) VALUES (1, ?, ?)
       ON CONFLICT(id) DO UPDATE SET phase=excluded.phase, updated_at=excluded.updated_at`
    )
    .run(phase, new Date().toISOString())
}

async function clearRegisteredPersonalStores(): Promise<void> {
  for (const store of personalStores) store.beforeDelete?.()
  clearTables(...personalStores.flatMap((store) => store.tables ?? []))
  clearDirs(
    ...personalStores.flatMap((store) => store.dirs ?? []).map((directory) => ud(directory)),
    ud('lancedb')
  )
  galleryPrivacy.clearDesktopGeneratedImageMigrationState()
  clearFiles(...personalStores.flatMap((store) => store.files ?? []).map((file) => ud(file)))
  resetVectors()
  pruneDanglingMeetings()
}

function confirmRegisteredPersonalStoresEmpty(): void {
  const db = getDB()
  for (const table of personalStores.flatMap((store) => store.tables ?? [])) {
    try {
      const count = (
        db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }
      ).count
      if (count !== 0) throw new Error(`Personal-data table ${table} is not empty.`)
    } catch (error) {
      if (!isMissingTable(error)) throw error
    }
  }
  const dirs = [
    ...personalStores.flatMap((store) => store.dirs ?? []).map((directory) => ud(directory)),
    ud('lancedb')
  ]
  for (const directory of dirs) {
    try {
      if (fs.readdirSync(directory).length !== 0)
        throw new Error(`Personal-data directory ${directory} is not empty.`)
    } catch (error) {
      if (!isMissingPath(error)) throw error
    }
  }
  for (const file of personalStores.flatMap((store) => store.files ?? []).map((item) => ud(item))) {
    try {
      fs.statSync(file)
      throw new Error(`Personal-data file ${file} still exists.`)
    } catch (error) {
      if (!isMissingPath(error)) throw error
    }
  }
}

async function runFullDeleteIntent(): Promise<void> {
  const completionVersion = await withDeletionGuards(
    { scope: 'all' },
    async () => {
      let publicationIntent = pendingPrivacyPublicationIntent()
      if (!publicationIntent || publicationIntent.scope === 'chats') {
        // Admission is closed and drained here, so this is the exact set canonical deletion sees.
        publicationIntent = preparePrivacyPublicationIntent('all', readyWorkspaceContent())
      }
      const phase = readFullDeletePhase()
      if (phase === 'canonical_content') {
        await clearCanonicalWorkspaceContent()
        await saveFullDeletePhase('legacy_cleanup')
      }
      if (readFullDeletePhase() === 'legacy_cleanup') {
        await clearRegisteredPersonalStores()
        confirmRegisteredPersonalStoresEmpty()
      }
      if (pendingPrivacyPublicationIntent()?.phase === 'canonical_content') {
        publicationIntent = advancePrivacyPublicationIntent(publicationIntent.version)
      }
      return publicationIntent.version
    },
    true
  )
  completePrivacyPublicationIntent(completionVersion)
  getDB().prepare('DELETE FROM data_privacy_delete_all_intent WHERE id = 1').run()
}

/** Resume the one durable full-delete coordinator after Workspace Content is ready. */
async function resumePendingDataDeletionNow(): Promise<void> {
  const fullDeletePending = readFullDeletePhase() !== null
  const publicationIntent = pendingPrivacyPublicationIntent()
  const publicationPending = publicationIntent !== null
  if (!fullDeletePending && !publicationPending) return Promise.resolve()
  if (fullDeletePending) return runFullDeleteIntent()
  const completionVersion = await withDeletionGuards(
    { scope: publicationIntent?.scope ?? 'chats' },
    async () => {
      let current = pendingPrivacyPublicationIntent()
      if (current?.phase === 'canonical_content') {
        if (current.scope !== 'chats') throw new Error('Full privacy recovery intent is missing.')
        await clearCanonicalChats()
        clearTables(...LEGACY_CHAT_UPGRADE_TABLES)
        clearDirs(ud('uploads'))
        current = advancePrivacyPublicationIntent(current.version)
      }
      if (!current) throw new Error('Privacy publication did not settle.')
      return current.version
    },
    true
  )
  completePrivacyPublicationIntent(completionVersion)
}

/** Resume the one durable deletion coordinator after Workspace Content is ready. */
export function resumePendingFullDataDeletion(): Promise<void> {
  return enqueueDeletion(resumePendingDataDeletionNow)
}

export function hasPendingWorkspacePrivacySettlement(): boolean {
  return readFullDeletePhase() !== null || pendingPrivacyPublicationIntent() !== null
}

/** Summary of what's stored, per category, for the Delete-my-data screen. */
export function getDataSummary(): DataCategory[] {
  const workspaceContent = readyWorkspaceContent()
  const captures = dirSize(ud('captures'))
  const meetings = dirSize(ud('meetings'))
  const images = (() => {
    const a = dirSize(ud('generated-images')),
      b = dirSize(ud('artifacts-library')),
      c = dirSize(ud('style-thumbs'))
    return { bytes: a.bytes + b.bytes + c.bytes, files: a.files + b.files + c.files }
  })()
  return [
    {
      id: 'chats',
      label: 'Chats',
      detail: 'Conversations and messages',
      count: workspaceContent.conversations.length
    },
    {
      id: 'memories',
      label: 'Memory & entities',
      detail: 'Observations, entities, and what Off Grid AI has learned',
      count: tableCount('memories') + tableCount('entities')
    },
    {
      id: 'captures',
      label: 'Screen captures',
      detail: 'Captured frames and OCR',
      count: captures.files,
      bytes: captures.bytes
    },
    {
      id: 'meetings',
      label: 'Meetings',
      detail: 'Recordings and transcripts',
      count: meetings.files,
      bytes: meetings.bytes
    },
    {
      id: 'images',
      label: 'Generated images & artifacts',
      detail: 'Images, artifacts, and thumbnails',
      count: images.files,
      bytes: images.bytes
    }
  ]
}

/** Delete one category of data (SQL rows + its directories). For captures/meetings,
 *  pass olderThanDays to delete only entries older than N days (retention cleanup). */
async function clearCategoryNow(
  id: DataCategory['id'],
  olderThanDays?: number
): Promise<{ success: boolean }> {
  try {
    let completionVersion: number | null = null
    const guarded = await withDeletionGuards({ scope: id, olderThanDays }, async () => {
      switch (id) {
        case 'chats':
          // Admission is closed and drained before exact identities become durable.
          completionVersion = preparePrivacyPublicationIntent(
            'chats',
            readyWorkspaceContent()
          ).version
          await clearCanonicalChats()
          // The canonical delete succeeded. Remove only obsolete upgrade inputs now.
          clearTables(...LEGACY_CHAT_UPGRADE_TABLES)
          clearDirs(ud('uploads'))
          completionVersion = advancePrivacyPublicationIntent(completionVersion).version
          break
        case 'memories':
          clearTables(...MEMORY_TABLES)
          clearDirs(ud('entity-photos'))
          // Delete ONLY the memory-side vectors (not the shared lancedb dir — that
          // would wipe capture/meeting/chat vectors and dangle the live handle).
          await deleteByKinds(['memory', 'entity', 'fact'])
          break
        case 'captures':
          if (olderThanDays && olderThanDays > 0) {
            clearDirsOlderThan(olderThanDays, ud('captures'))
            await deleteByKindsOlderThan(['screen'], Date.now() - olderThanDays * 86_400_000) // prune stale capture vectors too
          } else {
            clearDirs(ud('captures'))
            await deleteByKinds(['screen']) // full clear → drop capture vectors too
            // Registered cleaners below remove the semantic source rows. Drop their indexing
            // receipts here as well so a future capture can never inherit a stale marker.
            try {
              getDB()
                .prepare("DELETE FROM vec_indexed WHERE key LIKE 'obs:%' OR key LIKE 'frame:%'")
                .run()
            } catch {
              /* search index has not been initialized */
            }
          }
          break
        case 'meetings':
          if (olderThanDays && olderThanDays > 0) {
            clearDirsOlderThan(olderThanDays, ud('meetings'))
            await deleteByKindsOlderThan(['meeting'], Date.now() - olderThanDays * 86_400_000) // prune stale meeting vectors too
          } else {
            clearDirs(ud('meetings'))
            await deleteByKinds(['meeting']) // full clear → drop meeting vectors too
          }
          pruneDanglingMeetings() // drop rows whose media we just deleted (no ghosts)
          break
        case 'images':
          await galleryPrivacy.clearDesktopGeneratedImageGallery()
          clearDirs(ud('generated-images'), ud('artifacts-library'), ud('style-thumbs'))
          galleryPrivacy.clearDesktopGeneratedImageMigrationState()
          break
      }
      for (const cleaner of categoryCleaners.get(id)?.values() ?? []) {
        await cleaner({ olderThanDays })
      }
      return { result: { success: true }, completionVersion }
    })
    if (id === 'chats') {
      if (guarded.completionVersion === null) throw new Error('Privacy publication did not settle.')
      completePrivacyPublicationIntent(guarded.completionVersion)
    }
    return guarded.result
  } catch (e) {
    // Surface failure instead of falsely claiming the data (incl. its vectors) was cleared.
    console.error('[data-privacy] clearCategory failed', id, e)
    return { success: false }
  }
}

export function clearCategory(
  id: DataCategory['id'],
  olderThanDays?: number
): Promise<{ success: boolean }> {
  return enqueueDeletion(async () => {
    if (id === 'chats' && pendingPrivacyPublicationIntent()) {
      try {
        await resumePendingDataDeletionNow()
        return { success: true }
      } catch (error) {
        console.error('[data-privacy] Chats recovery failed', error)
        return { success: false }
      }
    }
    return clearCategoryNow(id, olderThanDays)
  })
}

/** Delete ALL personal data (every registered store + the user profile). Leaves
 *  installed models, license, and app preferences intact. Iterates the
 *  personalStores registry so nothing is missed as tables/dirs are added — the fix
 *  for the drift that once let captures/connectors/secrets/RAG docs survive here. */
export async function deleteAllData(): Promise<{ success: boolean }> {
  return enqueueDeletion(async () => {
    try {
      if (readFullDeletePhase() === null) await saveFullDeletePhase('canonical_content')
      await resumePendingDataDeletionNow()
      return { success: true }
    } catch (error) {
      console.error('[data-privacy] deleteAllData failed', error)
      return { success: false }
    }
  })
}
