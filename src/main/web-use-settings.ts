import { getSetting, saveSetting } from './database'
import { announceTaskSettings } from './task-settings-events'
import {
  DEFAULT_WEB_USE_SETTINGS,
  WEB_USE_SETTINGS_KEY,
  normalizeWebUseSettings,
  type WebUseSettings
} from '../shared/web-use-settings'
import { CORE_SYNC_ENTITIES, emitSyncMutation } from './sync-mutation'

/** Settings that apply for one run only and are never saved (the Web Use task list runner). */
let override: Partial<WebUseSettings> | null = null

export function setWebUseSettingsOverride(value: Partial<WebUseSettings> | null): void {
  override = value
}

export function getWebUseSettings(): WebUseSettings {
  const saved = getSetting<unknown>(WEB_USE_SETTINGS_KEY, DEFAULT_WEB_USE_SETTINGS)
  return normalizeWebUseSettings(override ? { ...(saved as object), ...override } : saved)
}

export function setWebUseSettings(
  value: unknown,
  options: { emitSync?: boolean } = {}
): WebUseSettings {
  const normalized = normalizeWebUseSettings(value)
  saveSetting(WEB_USE_SETTINGS_KEY, normalized)
  announceTaskSettings(WEB_USE_SETTINGS_KEY, normalized)
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
