import { callHook, HOOKS } from './bootstrap/hookRegistry'
import { CORE_SYNC_ENTITIES, type SyncMutation } from '@offgrid/sync'
import { encodeChangedModelSettings } from '@offgrid/models'
export { SYNCABLE_COMPUTER_USE_SETTING_KEYS, SYNCABLE_LLM_SETTING_KEYS } from '@offgrid/models'
// The committed-mutation contract (entity table, mutation shape) is shared with Off Grid Mobile.
export { CORE_SYNC_ENTITIES } from '@offgrid/sync'
export type { CoreSyncEntity, SyncMutation } from '@offgrid/sync'

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
  try {
    callHook(HOOKS.syncRecordLocalMutation, mutation)
  } catch (error) {
    console.error('[sync] Failed to record committed mutation', mutation, error)
  }
}
