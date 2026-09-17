import { getSetting, saveSetting } from './database'
import {
  DEFAULT_WEB_USE_SETTINGS,
  WEB_USE_SETTINGS_KEY,
  normalizeWebUseSettings,
  type WebUseSettings
} from '../shared/web-use-settings'
import { CORE_SYNC_ENTITIES, emitSyncMutation } from './sync-mutation'

export function getWebUseSettings(): WebUseSettings {
  return normalizeWebUseSettings(
    getSetting<unknown>(WEB_USE_SETTINGS_KEY, DEFAULT_WEB_USE_SETTINGS)
  )
}

export function setWebUseSettings(
  value: unknown,
  options: { emitSync?: boolean } = {}
): WebUseSettings {
  const normalized = normalizeWebUseSettings(value)
  saveSetting(WEB_USE_SETTINGS_KEY, normalized)
  if (options.emitSync !== false) {
    emitSyncMutation({
      entity: CORE_SYNC_ENTITIES.modelSetting,
      entityId: WEB_USE_SETTINGS_KEY,
      kind: 'put',
      fields: { value: normalized }
    })
  }
  return normalized
}
