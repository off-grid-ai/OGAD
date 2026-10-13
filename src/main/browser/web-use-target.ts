// Which browser a web_use task runs in. Pure, so the choice is tested without a browser.
//
// With Tasks > Web Use set to the default browser, the task runs in a connected browser
// extension, preferring the one in the user's default browser. If no browser is connected,
// it runs in Off Grid AI's own browser, as it always has.

import type { WebUseBrowserTarget } from '../../shared/web-use-settings'

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
