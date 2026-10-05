// Which browser a web_use task runs in. Pure, so the choice is tested without a browser.
//
// With Tasks > Web Use set to the default browser, the task runs in a connected browser
// extension, preferring the one in the user's default browser. If no browser is connected,
// it runs in Off Grid AI's own browser, as it always has.

import type { WebUseBrowserTarget } from '../../shared/web-use-settings'
import { BROWSER_ORIGIN_PREFIX } from '../extension-bridge/bridge-conversations'

const FAMILIES: ReadonlyArray<readonly [string, RegExp]> = [
  ['brave', /brave/i],
  ['edge', /edge|edg\b/i],
  ['opera', /opera|opr\b/i],
  ['vivaldi', /vivaldi/i],
  ['arc', /\barc\b/i],
  ['firefox', /firefox/i],
  ['chrome', /chrome|chromium/i]
]

/** A browser's family from any name for it: an app name, a ProgId, an extension's device name. */
export function browserFamily(name: string | null | undefined): string | null {
  if (!name) return null
  return FAMILIES.find(([, pattern]) => pattern.test(name))?.[0] ?? null
}

export function pickBrowserLink<T extends { browser: { name: string } }>(
  target: WebUseBrowserTarget,
  links: readonly T[],
  defaultBrowser: string | null
): T | null {
  if (target !== 'default_browser' || links.length === 0) return null
  const family = browserFamily(defaultBrowser)
  return links.find((l) => family && browserFamily(l.browser.name) === family) ?? links[0] ?? null
}

/**
 * A task a browser's chat asked for, with that chat's tab offered (browser-start-tab.ts), runs
 * in that browser whatever Tasks > Web Use says: the user asked from there, for that tab. Its
 * journey is the browser's origin (BROWSER_ORIGIN_PREFIX + id). Null for any other task, or when that browser is not connected.
 */
export function pickRequestingLink<T extends { browser: { id: string } }>(
  journeyId: string,
  links: readonly T[],
  hasOffer: (browserId: string) => boolean
): T | null {
  const id = journeyId.startsWith(BROWSER_ORIGIN_PREFIX)
    ? journeyId.slice(BROWSER_ORIGIN_PREFIX.length)
    : ''
  return id && hasOffer(id) ? (links.find((l) => l.browser.id === id) ?? null) : null
}
