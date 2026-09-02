import { getSetting, saveSetting } from './database'
import {
  COMPUTER_USE_SETTINGS_KEY,
  DEFAULT_COMPUTER_USE_SETTINGS,
  normalizeComputerUseSettings,
  type ComputerUseSettingsPatch,
  type ComputerUseSettingsPortResult,
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

function unavailable(
  code: 'computer_use_settings_read_failed' | 'computer_use_settings_write_failed',
  error: unknown
): ComputerUseSettingsPortResult {
  const detail = error instanceof Error && error.message.trim() ? ` ${error.message.trim()}` : ''
  return {
    status: 'unavailable',
    error: {
      code,
      message: `Computer Use settings are unavailable.${detail}`
    }
  }
}

/** Main-owned read port. Generic app settings never become a second Computer Use policy owner. */
export function readComputerUseSettings(): ComputerUseSettingsPortResult {
  try {
    return { status: 'available', settings: getComputerUseSettings() }
  } catch (error) {
    return unavailable('computer_use_settings_read_failed', error)
  }
}

/**
 * Patch the authoritative object from its latest persisted value.
 * The renderer never writes fields it did not successfully read.
 */
export function patchComputerUseSettings(
  patch: ComputerUseSettingsPatch
): ComputerUseSettingsPortResult {
  try {
    const current = getComputerUseSettings()
    return { status: 'available', settings: setComputerUseSettings({ ...current, ...patch }) }
  } catch (error) {
    return unavailable('computer_use_settings_write_failed', error)
  }
}
