import { callHook, HOOKS } from './bootstrap/hookRegistry'
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
 */
export function emitSyncMutation(mutation: SyncMutation): void {
  callHook(HOOKS.syncRecordLocalMutation, mutation)
}
