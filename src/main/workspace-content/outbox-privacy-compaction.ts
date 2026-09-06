import {
  validateWorkspaceContentOutboxPrivacyTargets,
  type Outcome,
  type WorkspaceContentFailure,
  type WorkspaceContentOutboxPrivacyCompactionResult,
  type WorkspaceContentOutboxPrivacyTarget
} from '@offgrid/application'
import type Database from 'better-sqlite3-multiple-ciphers'

/** Desktop SQLite adapter for the Shared outbox privacy-compaction contract. */
export function compactDeletedWorkspaceContentOutbox(
  db: Database.Database,
  targets: readonly WorkspaceContentOutboxPrivacyTarget[]
): Outcome<WorkspaceContentOutboxPrivacyCompactionResult, WorkspaceContentFailure> {
  try {
    const invalid = validateWorkspaceContentOutboxPrivacyTargets(targets)
    if (invalid) return { ok: false, failure: invalid }
    return db.transaction(() => {
      let removedRows = 0
      let retainedTombstones = 0
      for (const target of targets) {
        removedRows += db
          .prepare(
            `DELETE FROM workspace_content_outbox
             WHERE entity_type = ? AND entity_id = ?
               AND (operation = 'put' OR delivered_at IS NOT NULL)`
          )
          .run(target.entity, target.entityId).changes
        retainedTombstones += db
          .prepare(
            `UPDATE workspace_content_outbox SET payload_json = ?
             WHERE entity_type = ? AND entity_id = ?
               AND operation = 'delete' AND delivered_at IS NULL`
          )
          .run(JSON.stringify({ id: target.entityId }), target.entity, target.entityId).changes
      }
      return { ok: true as const, value: { removedRows, retainedTombstones } }
    })()
  } catch (cause) {
    return {
      ok: false,
      failure: {
        kind: 'persistence',
        message: cause instanceof Error ? cause.message : String(cause)
      }
    }
  }
}
