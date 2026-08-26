import { getSetting, saveSetting } from './database'
import {
  COMPUTER_USE_SETTINGS_KEY,
  DEFAULT_COMPUTER_USE_SETTINGS,
  normalizeComputerUseSettings,
  type ComputerUseSettings
} from '../shared/computer-use-settings'
import { CORE_SYNC_ENTITIES, emitSyncMutation } from './sync-mutation'

export function getComputerUseSettings(): ComputerUseSettings {
  return normalizeComputerUseSettings(
    getSetting<unknown>(COMPUTER_USE_SETTINGS_KEY, DEFAULT_COMPUTER_USE_SETTINGS)
  )
}

export function setComputerUseSettings(
  value: unknown,
  options: { emitSync?: boolean } = {}
): ComputerUseSettings {
  const normalized = normalizeComputerUseSettings(value)
  saveSetting(COMPUTER_USE_SETTINGS_KEY, normalized)
  if (options.emitSync !== false) {
    emitSyncMutation({
      entity: CORE_SYNC_ENTITIES.modelSetting,
      entityId: COMPUTER_USE_SETTINGS_KEY,
      kind: 'put',
      fields: { value: normalized }
    })
  }
  return normalized
}
