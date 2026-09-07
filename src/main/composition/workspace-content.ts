import { randomUUID } from 'node:crypto'
import type {
  WorkspaceContentOutboxDeliveryOwner,
  WorkspaceContentOutboxEntry,
  WorkspaceContentOutboxPrivacyTarget,
  WorkspaceContentRepositoryPort
} from '@offgrid/application'
import {
  createWorkspaceContentOutboxDeliveryOwner,
  workspaceContentSyncMutation
} from '@offgrid/application'
import { getDB } from '../database'
import { deliverSyncMutationOrThrow } from '../sync-mutation'
import {
  inspectWorkspaceContentMigration,
  type WorkspaceContentMigrationPreflight
} from '../workspace-content/migration-preflight'
import {
  DesktopWorkspaceContentMigrationCoordinator,
  type LegacyWorkspaceContentCopyResult,
  type WorkspaceContentTargetJournalStatus
} from '../workspace-content/legacy-migration'
import { DesktopWorkspaceContentRepository } from '../workspace-content/repository'
import { ensureRagStoreSchema } from '../rag/store'
import {
  DesktopProjectDeletionIntentRepository,
  desktopProjectArtifactCleanup
} from '../workspace-content/project-deletion-recovery'
import type { ProjectDeletionRecoveryPorts } from '@offgrid/application'
import { retireLegacyProjectOwner } from '../workspace-content/legacy-project-retirement'

export interface DesktopWorkspaceContentPersistence {
  readonly repository: WorkspaceContentRepositoryPort
  readonly preflight: WorkspaceContentMigrationPreflight
  readTargetJournalStatus(): WorkspaceContentTargetJournalStatus
  copyLegacyWorkspaceContent(): LegacyWorkspaceContentCopyResult
  retireLegacyProjectOwner(): void
  readonly outbox: WorkspaceContentOutboxDeliveryOwner
  readonly privacy: {
    compactDeletedOutbox(targets: readonly WorkspaceContentOutboxPrivacyTarget[]): Promise<void>
    settleLocalResourceReleases(): Promise<void>
    suspendLocalResourceReleases(): Promise<void>
    resumeLocalResourceReleases(): void
  }
  startLocalResourceReleaseRecovery(): Promise<void>
  stopLocalResourceReleaseRecovery(): Promise<void>
  /**
   * Every project-deletion port this module can own on its own. `media` is deliberately absent:
   * the generated-image cleanup needs the single composed gallery repository's byte-journal
   * settlement, which only the application composition holds, so it is injected there.
   */
  readonly projectDeletionRecovery: Omit<ProjectDeletionRecoveryPorts, 'media'>
}

/**
 * The thin transport `createWorkspaceContentOutboxDeliveryOwner` calls per claimed entry. It
 * translates an already-decided change into the same wire shape every other Sync producer builds,
 * then hands it to the strict delivery boundary (`deliverSyncMutationOrThrow`) - never the
 * fire-and-forget `emitSyncMutation`, which returns success-like void with no hook registered or a
 * failed handler. A rejected promise here is what lets Shared's outbox owner leave the claimed row
 * pending/retryable instead of acknowledging a mutation Sync never recorded. No retry, batching, or
 * transport policy belongs here; Shared owns all of that.
 */
function desktopWorkspaceContentOutboxTransport(): {
  deliver(entry: WorkspaceContentOutboxEntry): Promise<void>
} {
  return {
    deliver: async (entry) => {
      const mutation = workspaceContentSyncMutation(entry.change, entry.syncOperationId)
      if (!mutation.ok) throw new Error(mutation.failure.message)
      await deliverSyncMutationOrThrow(mutation.value)
    }
  }
}

let persistence: DesktopWorkspaceContentPersistence | null = null

/** Callable composition seam for the Shared workspace-content owner and migration workflow. */
export function desktopWorkspaceContentPersistence(): DesktopWorkspaceContentPersistence {
  if (persistence) return persistence
  ensureRagStoreSchema()
  const db = getDB()
  const migration = new DesktopWorkspaceContentMigrationCoordinator(db)
  const repository = new DesktopWorkspaceContentRepository(db)
  persistence = {
    repository,
    preflight: inspectWorkspaceContentMigration(db),
    readTargetJournalStatus: () => migration.readTargetJournalStatus(),
    copyLegacyWorkspaceContent: () => migration.copyLegacyWorkspaceContent(),
    retireLegacyProjectOwner: () => retireLegacyProjectOwner(db),
    outbox: createWorkspaceContentOutboxDeliveryOwner({
      repository,
      delivery: desktopWorkspaceContentOutboxTransport(),
      newClaimId: randomUUID
    }),
    privacy: {
      compactDeletedOutbox: async (targets) => {
        const outcome = await repository.compactDeletedOutbox(targets)
        if (!outcome.ok) throw new Error(outcome.failure.message)
        for (const target of targets) {
          const rows = db
            .prepare(
              `SELECT operation, payload_json, delivered_at FROM workspace_content_outbox
               WHERE entity_type = ? AND entity_id = ?`
            )
            .all(target.entity, target.entityId) as Array<{
            operation: string
            payload_json: string
            delivered_at: string | null
          }>
          if (
            rows.some(
              (row) =>
                row.operation !== 'delete' ||
                row.delivered_at !== null ||
                row.payload_json !== JSON.stringify({ id: target.entityId })
            )
          ) {
            throw new Error(
              `Workspace Content outbox privacy residue remains for ${target.entity}/${target.entityId}.`
            )
          }
        }
      },
      settleLocalResourceReleases: () => repository.localResourceReleases.settleForPrivacy(),
      suspendLocalResourceReleases: () => repository.localResourceReleases.suspend(),
      resumeLocalResourceReleases: () => repository.localResourceReleases.resume()
    },
    startLocalResourceReleaseRecovery: () => repository.localResourceReleases.start(),
    stopLocalResourceReleaseRecovery: () => repository.localResourceReleases.stop(),
    projectDeletionRecovery: {
      intents: new DesktopProjectDeletionIntentRepository(db),
      artifacts: desktopProjectArtifactCleanup,
      now: () => new Date().toISOString()
    }
  }
  return persistence
}
