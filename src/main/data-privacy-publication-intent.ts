import type {
  WorkspaceContentOutboxPrivacyTarget,
  WorkspaceContentSnapshot
} from '@offgrid/application'
import { getDB } from './database'

export type PrivacyPublicationScope = 'chats' | 'all'
export type PrivacyPublicationPhase = 'canonical_content' | 'publication_compaction'
export interface PrivacyPublicationIntent {
  version: number
  scope: PrivacyPublicationScope
  phase: PrivacyPublicationPhase
  targets: readonly WorkspaceContentOutboxPrivacyTarget[]
}

function ensureTable(): void {
  getDB().exec(`CREATE TABLE IF NOT EXISTS data_privacy_publication_intent (
    id INTEGER PRIMARY KEY CHECK (id = 1), scope TEXT NOT NULL,
    targets_json TEXT NOT NULL, phase TEXT NOT NULL, updated_at TEXT NOT NULL
  )`)
  const columns = getDB().prepare('PRAGMA table_info(data_privacy_publication_intent)').all() as {
    name: string
  }[]
  if (!columns.some(({ name }) => name === 'version')) {
    getDB().exec(
      'ALTER TABLE data_privacy_publication_intent ADD COLUMN version INTEGER NOT NULL DEFAULT 1'
    )
  }
}

function targets(
  snapshot: WorkspaceContentSnapshot,
  scope: PrivacyPublicationScope
): WorkspaceContentOutboxPrivacyTarget[] {
  return [
    ...(scope === 'all'
      ? snapshot.projects.map(({ id }) => ({ entity: 'project' as const, entityId: id }))
      : []),
    ...snapshot.conversations.map(({ id }) => ({ entity: 'conversation' as const, entityId: id })),
    ...snapshot.messages.map(({ id }) => ({ entity: 'message' as const, entityId: id })),
    ...snapshot.chatTurns.map(({ id }) => ({ entity: 'chat_turns' as const, entityId: id }))
  ]
}

function targetKey(target: WorkspaceContentOutboxPrivacyTarget): string {
  return `${target.entity}\0${target.entityId}`
}

function mergedTargets(
  current: readonly WorkspaceContentOutboxPrivacyTarget[],
  next: readonly WorkspaceContentOutboxPrivacyTarget[]
): WorkspaceContentOutboxPrivacyTarget[] {
  const merged = new Map(current.map((target) => [targetKey(target), target]))
  for (const target of next) merged.set(targetKey(target), target)
  return [...merged.values()]
}

export function pendingPrivacyPublicationIntent(): PrivacyPublicationIntent | null {
  ensureTable()
  const row = getDB()
    .prepare(
      'SELECT scope, targets_json, phase, version FROM data_privacy_publication_intent WHERE id = 1'
    )
    .get() as
    | {
        scope: PrivacyPublicationScope
        targets_json: string
        phase: PrivacyPublicationPhase
        version: number
      }
    | undefined
  if (!row) return null
  if (!['chats', 'all'].includes(row.scope)) throw new Error('Invalid privacy publication scope.')
  if (!['canonical_content', 'publication_compaction'].includes(row.phase)) {
    throw new Error('Invalid privacy publication phase.')
  }
  const parsed: unknown = JSON.parse(row.targets_json)
  if (!Array.isArray(parsed)) throw new Error('Invalid privacy publication targets.')
  return {
    version: row.version,
    scope: row.scope,
    phase: row.phase,
    targets: parsed as WorkspaceContentOutboxPrivacyTarget[]
  }
}

export function preparePrivacyPublicationIntent(
  scope: PrivacyPublicationScope,
  snapshot: WorkspaceContentSnapshot
): PrivacyPublicationIntent {
  ensureTable()
  getDB().transaction(() => {
    const current = pendingPrivacyPublicationIntent()
    const nextTargets = targets(snapshot, scope)
    if (!current) {
      getDB()
        .prepare(
          `INSERT INTO data_privacy_publication_intent
           (id, scope, targets_json, phase, updated_at)
           VALUES (1, ?, ?, 'canonical_content', ?)`
        )
        .run(scope, JSON.stringify(nextTargets), new Date().toISOString())
      return
    }
    if (scope !== 'all' || current.scope !== 'chats') {
      throw new Error('A privacy publication settlement is already pending.')
    }
    const result = getDB()
      .prepare(
        `UPDATE data_privacy_publication_intent
         SET scope = 'all', targets_json = ?, phase = 'canonical_content',
             version = version + 1, updated_at = ? WHERE id = 1 AND version = ?`
      )
      .run(
        JSON.stringify(mergedTargets(current.targets, nextTargets)),
        new Date().toISOString(),
        current.version
      )
    if (result.changes !== 1) throw new Error('Privacy publication intent changed concurrently.')
  })()
  const prepared = pendingPrivacyPublicationIntent()
  if (!prepared) throw new Error('Privacy publication intent was not prepared.')
  return prepared
}

export function advancePrivacyPublicationIntent(expectedVersion: number): PrivacyPublicationIntent {
  const result = getDB()
    .prepare(
      `UPDATE data_privacy_publication_intent
       SET phase = 'publication_compaction', version = version + 1, updated_at = ?
       WHERE id = 1 AND phase = 'canonical_content' AND version = ?`
    )
    .run(new Date().toISOString(), expectedVersion)
  if (result.changes !== 1) throw new Error('Privacy publication intent cannot advance.')
  const advanced = pendingPrivacyPublicationIntent()
  if (!advanced) throw new Error('Privacy publication intent was not advanced.')
  return advanced
}

export function pendingWorkspacePrivacyTargets():
  readonly WorkspaceContentOutboxPrivacyTarget[] | null {
  const intent = pendingPrivacyPublicationIntent()
  if (!intent) return null
  if (intent.phase !== 'publication_compaction') {
    throw new Error('Canonical privacy deletion has not settled.')
  }
  return intent.targets
}

export function completePrivacyPublicationIntent(expectedVersion: number): void {
  const result = getDB()
    .prepare('DELETE FROM data_privacy_publication_intent WHERE id = 1 AND version = ?')
    .run(expectedVersion)
  if (result.changes !== 1) throw new Error('Privacy publication intent cannot complete.')
}
