import {
  DEFAULT_COMPUTER_USE_SETTINGS,
  normalizeComputerUseSettings,
  type ComputerUseSettings
} from './computer-use-settings'

/**
 * Where web_use runs. 'in_app' is Off Grid AI's own browser. 'default_browser' is the user's
 * default browser through the paired extension, signed in as the user; it applies only while
 * that browser is connected, otherwise tasks run in the Off Grid AI browser as before.
 */
export type WebUseBrowserTarget = 'in_app' | 'default_browser'

export type WebUseSettings = ComputerUseSettings & { browserTarget: WebUseBrowserTarget }

export const WEB_USE_SETTINGS_KEY = 'webUseSettings'

export const DEFAULT_WEB_USE_SETTINGS: Readonly<WebUseSettings> = {
  ...DEFAULT_COMPUTER_USE_SETTINGS,
  modelStrategy: 'same_as_chat',
  browserTarget: 'in_app'
}

export function normalizeWebUseSettings(value: unknown): WebUseSettings {
  const input = typeof value === 'object' && value !== null ? value : {}
  const target = (input as { browserTarget?: unknown }).browserTarget
  return {
    ...normalizeComputerUseSettings({ ...DEFAULT_WEB_USE_SETTINGS, ...input }),
    browserTarget: target === 'default_browser' ? 'default_browser' : 'in_app'
  }
}

/** Said on a task that ran in the Off Grid AI browser although Tasks > Web Use chose the default
 *  browser, because no browser with the extension was connected. */
export const DEFAULT_BROWSER_FALLBACK_NOTE =
  'Ran in the Off Grid AI browser: your browser was not connected.'
