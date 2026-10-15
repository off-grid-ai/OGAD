// One place to see and delete on-device data. Local-first: this is the user's
// data on their machine, so deletion is real and immediate (SQLite rows + the
// data directories). Models are intentionally NOT included here — they're managed
// (with sizes) in the Storage panel, and re-downloading is expensive.
import fs from 'fs'
import path from 'path'
import { app } from 'electron'
import { getDB } from './database'
import { ATTACHED_DOCUMENT_TABLES } from './documents/sqlite-store'
import { releaseRecordIndex } from './records/store'

export interface DataCategory {
  id: 'chats' | 'memories' | 'captures' | 'meetings' | 'images'
  label: string
  detail: string
  count?: number
  bytes?: number
}

const ud = (...p: string[]): string => path.join(app.getPath('userData'), ...p)

function dirSize(p: string): { bytes: number; files: number } {
  let bytes = 0,
    files = 0
  try {
    for (const name of fs.readdirSync(p)) {
      const fp = path.join(p, name)
      try {
        const st = fs.statSync(fp)
        if (st.isDirectory()) {
          const sub = dirSize(fp)
          bytes += sub.bytes
          files += sub.files
        } else {
          bytes += st.size
          files += 1
        }
      } catch {
        /* skip */
      }
    }
  } catch {
    /* missing dir */
  }
  return { bytes, files }
}

function clearDirs(...dirs: string[]): void {
  for (const d of dirs) {
    try {
      for (const name of fs.readdirSync(d))
        fs.rmSync(path.join(d, name), { recursive: true, force: true })
    } catch {
      /* missing */
    }
  }
}

/** Delete only entries older than `days` (by mtime) — for time-based retention on
 *  captures/meetings. Handles both flat files and day-subdirectories. */
function clearDirsOlderThan(days: number, ...dirs: string[]): void {
  const cutoff = Date.now() - days * 86400000
  for (const d of dirs) {
    try {
      for (const name of fs.readdirSync(d)) {
        const fp = path.join(d, name)
        try {
          if (fs.statSync(fp).mtimeMs < cutoff) fs.rmSync(fp, { recursive: true, force: true })
        } catch {
          /* skip */
        }
      }
    } catch {
      /* missing */
    }
  }
}

function tableCount(table: string): number {
  try {
    return (getDB().prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }).c
  } catch {
    return 0
  }
}

function clearTables(...tables: string[]): void {
  const db = getDB()
  for (const t of tables) {
    try {
      db.prepare(`DELETE FROM ${t}`).run()
    } catch {
      /* table may not exist */
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
  } catch {
    /* no meetings table (free build) */
  }
}

// Which SQL tables + directories belong to each UI category.
const CHAT_TABLES = [
  'conversations',
  'messages',
  'rag_conversations',
  'rag_messages',
  'chat_summaries',
  'conversation_document_exclusions'
]
// memories, master_memory and entity_facts are retired (nothing writes or reads them); they stay
// here so the rows a profile already has are still deleted with the rest.
const MEMORY_TABLES = [
  'memories',
  'master_memory',
  'entities',
  'entity_edges',
  'entity_facts',
  'entity_sessions'
]

/** Who keeps documents outside chats (a meeting its transcript, a long dictation its text): the
 *  owner prefix (`meeting` for "meeting:12") and the table its id lives in. Registered by the
 *  owning feature, so core never names its tables. */
const keptDocumentOwners = new Map<string, string>()

export function registerKeptDocumentOwner(prefix: string, table: string): void {
  keptDocumentOwners.set(prefix, table)
}

/**
 * After rows were deleted by a category clear or retention: owners that are gone keep nothing,
 * and every document nothing else uses (no chat, knowledge base or remaining owner) is deleted.
 * Throws when a document cannot be deleted.
 */
async function forgetDocumentsOfDeletedOwners(): Promise<void> {
  if (!keptDocumentOwners.size) return
  const { releaseDocumentsOfDeletedOwners, removeUnreferencedDocuments } = await import(
    './documents'
  )
  let released = 0
  for (const [prefix, table] of keptDocumentOwners)
    released += releaseDocumentsOfDeletedOwners(prefix, table)
  if (released) await removeUnreferencedDocuments()
}

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
  { tables: CHAT_TABLES, dirs: ['uploads'] },
  // Every indexed document (chat attachments, knowledge-base files, meeting transcripts, long
  // dictations) and which owner keeps which.
  { tables: ATTACHED_DOCUMENT_TABLES, dirs: [] },
  { tables: MEMORY_TABLES, dirs: ['entity-photos'] },
  // Project metadata + knowledge base. Children precede parents so deletion also
  // works when SQLite foreign-key enforcement is enabled.
  { tables: ['rag_documents', 'projects'], dirs: [] },
  { tables: ['connectors', 'secrets'], dirs: [] }, // MCP integrations + their OAuth tokens (must not survive a wipe)
  // Memory-search vectors and the queue of records waiting to be embedded. The in-memory index
  // built from them is dropped first.
  { tables: ['record_vectors', 'record_queue'], dirs: [], beforeDelete: releaseRecordIndex },
  { tables: ['user_profile'], dirs: [] },
  { tables: [], dirs: ['captures'] },
  { tables: [], dirs: ['meetings'] },
  { tables: [], dirs: ['generated-images', 'artifacts-library', 'style-thumbs'] }
]
const personalStores: PersonalStore[] = [...CORE_PERSONAL]

type CategoryCleaner = (context: { olderThanDays?: number }) => void | Promise<void>
const categoryCleaners = new Map<DataCategory['id'], Map<string, CategoryCleaner>>()

export type DataDeletionScope = DataCategory['id'] | 'all'
export interface DataDeletionContext {
  scope: DataDeletionScope
  olderThanDays?: number
}
export interface DataDeletionGuard {
  scopes: readonly DataDeletionScope[]
  /** Close admission synchronously, then resolve once already-admitted work is idle. */
  suspend(context: DataDeletionContext): void | Promise<void>
  /** Restore only state owned by this guard after durable deletion completes. */
  resume(context: DataDeletionContext): void | Promise<void>
}
const deletionGuards = new Map<string, DataDeletionGuard>()

/** Register a live personal-data producer by stable owner. Re-registration replaces the same
 * owner so module reloads cannot multiply destructive lifecycle hooks. */
export function registerDataDeletionGuard(owner: string, guard: DataDeletionGuard): () => void {
  deletionGuards.set(owner, guard)
  return () => {
    if (deletionGuards.get(owner) === guard) deletionGuards.delete(owner)
  }
}

async function withDeletionGuards<T>(
  context: DataDeletionContext,
  operation: () => T | Promise<T>
): Promise<T> {
  const active = [...deletionGuards.values()].filter((guard) =>
    guard.scopes.includes(context.scope)
  )
  const suspended: DataDeletionGuard[] = []
  let outcome: { ok: true; value: T } | { ok: false; error: unknown }
  try {
    // Invoke every suspend before the first await. Each owner closes admission synchronously;
    // their returned promises represent only the drain of work that was already admitted.
    const drains: Promise<void>[] = []
    for (const guard of active) {
      suspended.push(guard)
      try {
        drains.push(Promise.resolve(guard.suspend(context)))
      } catch (error) {
        drains.push(Promise.reject(error))
      }
    }
    const drainResults = await Promise.allSettled(drains)
    const drainFailures = drainResults
      .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      .map((result) => result.reason)
    if (drainFailures.length > 0) {
      throw new AggregateError(drainFailures, 'One or more data producers failed to suspend')
    }
    outcome = { ok: true, value: await operation() }
  } catch (error) {
    outcome = { ok: false, error }
  }

  const resumes = await Promise.allSettled(
    suspended.reverse().map((guard) => Promise.resolve(guard.resume(context)))
  )
  const resumeFailures = resumes
    .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
    .map((result) => result.reason)
  if (!outcome.ok) {
    if (resumeFailures.length > 0) {
      throw new AggregateError(
        [outcome.error, ...resumeFailures],
        'Data deletion failed and one or more producers failed to resume'
      )
    }
    throw outcome.error
  }
  if (resumeFailures.length > 0) {
    throw new AggregateError(resumeFailures, 'One or more data producers failed to resume')
  }
  return outcome.value
}

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

function clearFiles(...files: string[]): void {
  for (const file of files) {
    try {
      fs.rmSync(file, { force: true })
    } catch {
      /* missing or already removed */
    }
  }
}

/** Summary of what's stored, per category, for the Delete-my-data screen. */
export function getDataSummary(): DataCategory[] {
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
      count: tableCount('rag_conversations') + tableCount('conversations')
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
export async function clearCategory(
  id: DataCategory['id'],
  olderThanDays?: number
): Promise<{ success: boolean }> {
  try {
    return await withDeletionGuards({ scope: id, olderThanDays }, async () => {
      switch (id) {
        case 'chats': {
          clearTables(...CHAT_TABLES)
          clearDirs(ud('uploads'))
          // The documents attached to those chats go with them; a knowledge base's files and the
          // transcripts a meeting or dictation keeps stay.
          const { removeUnreferencedDocuments } = await import('./documents')
          await removeUnreferencedDocuments()
          break
        }
        case 'memories':
          // Each row's delete trigger removes its record vector in the same statement.
          clearTables(...MEMORY_TABLES)
          clearDirs(ud('entity-photos'))
          break
        case 'captures':
          // Registered cleaners below remove the capture rows; their delete triggers remove the
          // record vectors and full-text entries with them.
          if (olderThanDays && olderThanDays > 0) clearDirsOlderThan(olderThanDays, ud('captures'))
          else clearDirs(ud('captures'))
          break
        case 'meetings':
          if (olderThanDays && olderThanDays > 0) clearDirsOlderThan(olderThanDays, ud('meetings'))
          else clearDirs(ud('meetings'))
          pruneDanglingMeetings() // drop rows whose media we just deleted (no ghosts)
          break
        case 'images':
          clearDirs(ud('generated-images'), ud('artifacts-library'), ud('style-thumbs'))
          break
      }
      for (const cleaner of categoryCleaners.get(id)?.values() ?? []) {
        await cleaner({ olderThanDays })
      }
      // A meeting or recording deleted above (in full or by age) no longer keeps its transcript.
      await forgetDocumentsOfDeletedOwners()
      // Vectors of deleted rows went with them (delete triggers); the in-memory copy goes too.
      releaseRecordIndex()
      return { success: true }
    })
  } catch (e) {
    // Surface failure instead of falsely claiming the data (incl. its vectors) was cleared.
    console.error('[data-privacy] clearCategory failed', id, e)
    return { success: false }
  }
}

/** Delete ALL personal data (every registered store + the user profile). Leaves
 *  installed models, license, and app preferences intact. Iterates the
 *  personalStores registry so nothing is missed as tables/dirs are added — the fix
 *  for the drift that once let captures/connectors/secrets/RAG docs survive here. */
export async function deleteAllData(): Promise<{ success: boolean }> {
  try {
    return await withDeletionGuards({ scope: 'all' }, () => {
      for (const store of personalStores) store.beforeDelete?.()
      clearTables(...personalStores.flatMap((s) => s.tables ?? []))
      clearDirs(...personalStores.flatMap((s) => s.dirs ?? []).map((d) => ud(d)))
      clearFiles(...personalStores.flatMap((s) => s.files ?? []).map((file) => ud(file)))
      pruneDanglingMeetings() // media is gone now → drop all meeting rows (no ghosts)
      return { success: true }
    })
  } catch (error) {
    console.error('[data-privacy] deleteAllData failed', error)
    return { success: false }
  }
}
