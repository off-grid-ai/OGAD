import { callHook, hasHook, HOOKS } from './bootstrap/hookRegistry'
import {
  CORE_SYNC_ENTITIES as APPLICATION_SYNC_ENTITIES,
  encodeChangedModelSettings,
  type CoreSyncEntity,
  type SyncMutation
} from '@offgrid/application'

/**
 * TEST-ONLY COMPATIBILITY SHIM.
 * Production consumers import this contract from `@offgrid/application`. Delete these two exports
 * when the intentionally deferred test migration moves its imports to the application package.
 */
export const CORE_SYNC_ENTITIES = APPLICATION_SYNC_ENTITIES
export type { CoreSyncEntity, SyncMutation }

export function emitChangedLlmSettings(
  before: Record<string, unknown>,
  after: Record<string, unknown>
): void {
  for (const setting of encodeChangedModelSettings('desktop', before, after)) {
    emitSyncMutation({
      entity: CORE_SYNC_ENTITIES.modelSetting,
      entityId: setting.wireKey,
      kind: 'put',
      fields: { version: setting.version, value: JSON.parse(setting.valueJson) }
    })
  }
}

/**
 * Core owns its committed writes; Pro optionally records them. Free builds register no hook, so
 * this is an inert call with no sync engine or Pro business logic in the public application.
 *
 * Fire-and-forget: a missing hook or a handler failure is swallowed. Do not use this for any
 * caller that must acknowledge delivery (e.g. the Workspace Content outbox) - use
 * `deliverSyncMutationOrThrow` there instead, which surfaces both failure modes.
 */
export function emitSyncMutation(mutation: SyncMutation): void {
  try {
    callHook(HOOKS.syncRecordLocalMutation, mutation)
  } catch (error) {
    console.error('[sync] Failed to record committed mutation', mutation, error)
  }
}

/** Why a strict sync mutation delivery did not complete. */
export type SyncMutationDeliveryFailureReason = 'hook_unregistered' | 'handler_failed'

/** Typed failure from `deliverSyncMutationOrThrow`, carrying the original handler error when any. */
export class SyncMutationDeliveryError extends Error {
  readonly reason: SyncMutationDeliveryFailureReason

  constructor(reason: SyncMutationDeliveryFailureReason, cause?: unknown) {
    super(
      reason === 'hook_unregistered'
        ? 'No sync.recordLocalMutation hook is registered'
        : 'sync.recordLocalMutation handler failed'
    )
    this.name = 'SyncMutationDeliveryError'
    this.reason = reason
    if (cause !== undefined) this.cause = cause
  }
}

/**
 * Strict delivery boundary for callers that must not treat a mutation as delivered unless Sync
 * actually accepted it. Unlike `emitSyncMutation`, this throws `SyncMutationDeliveryError` when no
 * hook is registered or the handler fails, instead of returning success-like void - so a caller
 * that only acknowledges on a resolved promise (the Workspace Content outbox delivery port) can
 * leave the row pending/retryable rather than marking it delivered with nowhere it went.
 */
export async function deliverSyncMutationOrThrow(mutation: SyncMutation): Promise<void> {
  if (!hasHook(HOOKS.syncRecordLocalMutation)) {
    throw new SyncMutationDeliveryError('hook_unregistered')
  }
  try {
    callHook(HOOKS.syncRecordLocalMutation, mutation)
  } catch (error) {
    throw new SyncMutationDeliveryError('handler_failed', error)
  }
}
