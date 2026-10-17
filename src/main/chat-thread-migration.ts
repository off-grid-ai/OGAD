// Older builds kept an answer's versions inside the answer (context.variants), and an edited
// question's earlier wording with its answers in a list nobody could open (context.branches). This
// turns both into real versions: messages that follow the same message (chat-thread.ts in
// @offgrid/sync), so every surface shows them and none is lost.
//
// The plan is pure: rows in, writes out. It gives every message in a touched chat an explicit
// parent first, so the new rows cannot change which message an older one follows, and keeps the
// order the versions were made in through their stored times.

import { randomUUID } from 'node:crypto'
import { THREAD_ROOT, threadParents } from '@offgrid/sync'
import type Database from 'better-sqlite3-multiple-ciphers'
import { CORE_SYNC_ENTITIES, emitSyncMutation } from './sync-mutation'

export interface StoredThreadRow {
  id: number
  uuid: string
  role: string
  content: string
  context: string | null
  /** Milliseconds since the epoch. */
  createdMs: number
}

export interface ThreadMigrationPlan {
  updates: Array<{ id: number; uuid: string; context: Record<string, unknown> }>
  inserts: Array<{
    uuid: string
    role: 'user' | 'assistant'
    content: string
    context: Record<string, unknown>
    createdMs: number
  }>
}

/** A saved version as older builds wrote it; saved data may hold anything, null included. */
type Version = string | { content?: unknown; context?: unknown } | null

const contextOf = (json: string | null): Record<string, unknown> => {
  try {
    const value: unknown = JSON.parse(json ?? 'null')
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {}
  } catch {
    return {}
  }
}

const versionText = (version: Version): string =>
  typeof version === 'string'
    ? version
    : typeof version?.content === 'string'
      ? version.content
      : ''

const versionContext = (version: Version): Record<string, unknown> => {
  if (typeof version === 'string' || !version?.context || typeof version.context !== 'object')
    return {}
  const {
    variants: _v,
    variantIndex: _i,
    branches: _b,
    ...rest
  } = version.context as Record<string, unknown>
  return rest
}

/** The writes that turn one conversation's legacy versions into version rows. */
export function planThreadMigration(
  rows: readonly StoredThreadRow[],
  newId: () => string
): ThreadMigrationPlan {
  const contexts = new Map(rows.map((row) => [row.uuid, contextOf(row.context)]))
  const legacy = rows.some((row) => {
    const context = contexts.get(row.uuid)!
    return Array.isArray(context.variants) || Array.isArray(context.branches)
  })
  if (!legacy) return { updates: [], inserts: [] }
  const parents = threadParents(
    rows.map((row) => ({ uuid: row.uuid, parent: contexts.get(row.uuid)!.parent as string }))
  )
  const updates: ThreadMigrationPlan['updates'] = []
  const inserts: ThreadMigrationPlan['inserts'] = []
  for (const row of rows) {
    const context = { ...contexts.get(row.uuid)! }
    const parent = parents.get(row.uuid) ?? THREAD_ROOT
    context.parent = typeof context.parent === 'string' ? context.parent : parent
    const variants = Array.isArray(context.variants) ? (context.variants as Version[]) : undefined
    const branches = Array.isArray(context.branches)
      ? (context.branches as Array<{ question?: unknown; answers?: unknown } | null>)
      : undefined
    delete context.variants
    delete context.variantIndex
    delete context.branches
    if (variants && row.role === 'assistant' && variants.length > 1) {
      const index = Number.isInteger(contexts.get(row.uuid)!.variantIndex)
        ? Number(contexts.get(row.uuid)!.variantIndex)
        : variants.length - 1
      variants.forEach((version, i) => {
        if (i === index) return
        inserts.push({
          uuid: newId(),
          role: 'assistant',
          content: versionText(version),
          context: { ...versionContext(version), parent: context.parent, selectedAt: 0 },
          createdMs: row.createdMs + (i - index)
        })
      })
      context.selectedAt = 1
    }
    if (branches?.length && row.role === 'user') {
      branches.forEach((branch, j) => {
        if (typeof branch?.question !== 'string') return
        const question = newId()
        const askedMs = row.createdMs - (branches.length - j) * 100
        inserts.push({
          uuid: question,
          role: 'user',
          content: branch.question,
          context: { parent: context.parent, selectedAt: 0 },
          createdMs: askedMs
        })
        const answers = Array.isArray(branch.answers) ? (branch.answers as Version[]) : []
        answers.forEach((answer, a) =>
          inserts.push({
            uuid: newId(),
            role: 'assistant',
            content: versionText(answer),
            // The last answer was the one shown under that wording.
            context: {
              ...versionContext(answer),
              parent: question,
              selectedAt: a === answers.length - 1 ? 1 : 0
            },
            createdMs: askedMs + a + 1
          })
        )
      })
      context.selectedAt = 1
    }
    updates.push({ id: row.id, uuid: row.uuid, context })
  }
  return { updates, inserts }
}

const sqliteTime = (ms: number): string =>
  new Date(ms).toISOString().replace('T', ' ').replace('Z', '')

/** Migrate every conversation that still holds versions inside a message. Runs at start-up. */
export function migrateLegacyChatVersions(db: Database.Database): number {
  const conversations = db
    .prepare(
      `SELECT DISTINCT conversation_id AS id FROM rag_messages
       WHERE context LIKE '%"variants"%' OR context LIKE '%"branches"%'`
    )
    .all() as Array<{ id: string }>
  let migrated = 0
  for (const { id } of conversations) {
    const rows = (
      db
        .prepare(
          `SELECT id, uuid, role, content, context, created_at FROM rag_messages
           WHERE conversation_id = ? ORDER BY julianday(created_at) ASC, id ASC`
        )
        .all(id) as Array<Omit<StoredThreadRow, 'createdMs'> & { created_at: string }>
    ).map((row) => ({
      ...row,
      createdMs: Date.parse(
        `${row.created_at.replace(' ', 'T')}${/(?:[zZ]|[+-]\d\d:?\d\d)$/.test(row.created_at) ? '' : 'Z'}`
      )
    }))
    const plan = planThreadMigration(rows, () => randomUUID())
    if (!plan.updates.length && !plan.inserts.length) continue
    const update = db.prepare('UPDATE rag_messages SET context = ? WHERE id = ?')
    const insert = db.prepare(
      `INSERT INTO rag_messages (uuid, conversation_id, role, content, context, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    db.transaction(() => {
      for (const row of plan.updates) update.run(JSON.stringify(row.context), row.id)
      for (const row of plan.inserts)
        insert.run(
          row.uuid,
          id,
          row.role,
          row.content,
          JSON.stringify(row.context),
          sqliteTime(row.createdMs)
        )
    })()
    for (const row of [...plan.updates, ...plan.inserts])
      emitSyncMutation({ entity: CORE_SYNC_ENTITIES.message, entityId: row.uuid, kind: 'put' })
    migrated += 1
  }
  return migrated
}
