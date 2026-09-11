import type {
  DeletionContinuationResolution,
  DeletionContinuationResolverPort,
  DeletionRecoveryIdentity
} from '@offgrid/application'
import type Database from 'better-sqlite3-multiple-ciphers'
import { persistedWinningOperationStatus } from './remote-deletion-winner'

/** Rehydrate the exact remote-delete fence from Sync's durable winning operation. */
export class DesktopDeletionContinuationResolver implements DeletionContinuationResolverPort {
  constructor(private readonly db: Database.Database) {}

  async resolve(identity: DeletionRecoveryIdentity): Promise<DeletionContinuationResolution> {
    const { entity, entityId, remoteOperationId: operationId } = identity
    const status = (): 'current' | 'superseded' | 'not_ready' =>
      persistedWinningOperationStatus({ db: this.db, entity, entityId, operationId })
    const initial = status()
    if (initial !== 'current') return { status: initial }
    const isCurrent = (): boolean => {
      const current = status()
      if (current === 'not_ready') throw new Error('Remote deletion winner history is unavailable.')
      return current === 'current'
    }
    const expectedWinner = Object.freeze({ entity, entityId, operationId })
    return {
      status: 'current' as const,
      continuation: Object.freeze({
        entity,
        entityId,
        operationId,
        expectedWinner,
        isCurrent
      })
    }
  }
}
