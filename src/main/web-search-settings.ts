/**
 * Web search settings on the computer: where web_search sends searches (built in, the person's SearXNG
 * server, or their Brave Search or Tavily key). The choice is a setting; the key lives in secrets
 * (safeStorage), never in the settings table, and never goes back to the renderer.
 * Providers, order, parsing and the Test rule are @offgrid/models', the same as on the phone.
 */
import {
  WEB_SEARCH_PROVIDERS,
  DEFAULT_WEB_SEARCH_SETTINGS,
  normalizeSearxngUrl,
  searchWeb,
  testWebSearchProvider,
  webSearchKeyName,
  webSearchNeeds,
  type WebSearchProviderId,
  type WebSearchSettings,
  type WebSearchTestResult
} from '@offgrid/models'
import { ipcMain } from 'electron'
import { getSetting, saveSetting } from './database'
import { deleteSecret, getSecret, setSecret } from './secrets'

export const WEB_SEARCH_SETTINGS_KEY = 'webSearch'

const PROVIDERS: readonly WebSearchProviderId[] = WEB_SEARCH_PROVIDERS.map((p) => p.id)

function normalize(value: unknown): WebSearchSettings {
  const v = (value ?? {}) as Partial<WebSearchSettings>
  const provider = PROVIDERS.includes(v.provider as WebSearchProviderId)
    ? (v.provider as WebSearchProviderId)
    : DEFAULT_WEB_SEARCH_SETTINGS.provider
  const searxngUrl = typeof v.searxngUrl === 'string' ? normalizeSearxngUrl(v.searxngUrl) : ''
  return searxngUrl ? { provider, searxngUrl } : { provider }
}

export function getWebSearchSettings(): WebSearchSettings {
  return normalize(getSetting<unknown>(WEB_SEARCH_SETTINGS_KEY, DEFAULT_WEB_SEARCH_SETTINGS))
}

export function setWebSearchSettings(value: unknown): WebSearchSettings {
  const next = normalize(value)
  saveSetting(WEB_SEARCH_SETTINGS_KEY, next)
  return next
}

function keyFor(provider: WebSearchProviderId): string | null {
  return webSearchNeeds(provider) === 'key' ? getSecret(webSearchKeyName(provider)) : null
}

/** What the settings screen shows: the choice, and which key providers have a key saved. */
export function webSearchState(): { settings: WebSearchSettings; keys: Record<string, boolean> } {
  return {
    settings: getWebSearchSettings(),
    keys: Object.fromEntries(
      WEB_SEARCH_PROVIDERS.filter((p) => p.needs === 'key').map((p) => [p.id, Boolean(keyFor(p.id))])
    )
  }
}

export function setWebSearchKey(provider: WebSearchProviderId, key: string): boolean {
  if (webSearchNeeds(provider) !== 'key' || !key.trim()) return false
  return setSecret(webSearchKeyName(provider), key.trim())
}

export function removeWebSearchKey(provider: WebSearchProviderId): void {
  if (webSearchNeeds(provider) === 'key') deleteSecret(webSearchKeyName(provider))
}

/** Settings → Tools → Web search → Test: saves the choice, then asks only that provider. */
export async function testWebSearch(value: unknown): Promise<WebSearchTestResult> {
  const settings = setWebSearchSettings(value)
  return testWebSearchProvider({ fetch, settings, apiKey: keyFor(settings.provider) })
}

/** web_search's search: the person's provider first, then the built-in ones. */
export function searchTheWeb(query: string): ReturnType<typeof searchWeb> {
  const settings = getWebSearchSettings()
  return searchWeb(query, {
    fetch,
    settings,
    apiKey: keyFor(settings.provider),
    onRefused: (provider, reason) => console.warn(`[web_search] ${provider} refused: ${reason}`)
  })
}

/** Settings → Tools → Web search, for the renderer. The key goes in, never back out. */
export function registerWebSearchIpc(): void {
  ipcMain.handle('web-search:state', () => webSearchState())
  ipcMain.handle('web-search:save', (_e, value: unknown) => setWebSearchSettings(value))
  ipcMain.handle('web-search:set-key', (_e, provider: unknown, key: unknown) =>
    setWebSearchKey(provider as WebSearchProviderId, typeof key === 'string' ? key : '')
  )
  ipcMain.handle('web-search:remove-key', (_e, provider: unknown) =>
    removeWebSearchKey(provider as WebSearchProviderId)
  )
  ipcMain.handle('web-search:test', (_e, value: unknown) => testWebSearch(value))
}
