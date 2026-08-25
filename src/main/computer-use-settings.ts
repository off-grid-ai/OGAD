import { getSetting, saveSetting } from './database'
import {
  COMPUTER_USE_SETTINGS_KEY,
  DEFAULT_COMPUTER_USE_SETTINGS,
  normalizeComputerUseSettings,
  type ComputerUseSettings
} from '../shared/computer-use-settings'

export function getComputerUseSettings(): ComputerUseSettings {
  return normalizeComputerUseSettings(
    getSetting<unknown>(COMPUTER_USE_SETTINGS_KEY, DEFAULT_COMPUTER_USE_SETTINGS)
  )
}

export function setComputerUseSettings(value: unknown): ComputerUseSettings {
  const normalized = normalizeComputerUseSettings(value)
  saveSetting(COMPUTER_USE_SETTINGS_KEY, normalized)
  return normalized
}
