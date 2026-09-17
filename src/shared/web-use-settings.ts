import {
  DEFAULT_COMPUTER_USE_SETTINGS,
  normalizeComputerUseSettings,
  type ComputerUseSettings
} from './computer-use-settings'

export type WebUseSettings = ComputerUseSettings

export const WEB_USE_SETTINGS_KEY = 'webUseSettings'

export const DEFAULT_WEB_USE_SETTINGS: Readonly<WebUseSettings> = {
  ...DEFAULT_COMPUTER_USE_SETTINGS,
  modelStrategy: 'same_as_chat'
}

export function normalizeWebUseSettings(value: unknown): WebUseSettings {
  const normalized = normalizeComputerUseSettings({
    ...DEFAULT_WEB_USE_SETTINGS,
    ...(typeof value === 'object' && value !== null ? value : {})
  })
  return normalized
}
