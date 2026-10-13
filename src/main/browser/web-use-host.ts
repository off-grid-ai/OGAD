// The one place web_use picks its browser for a task: the user's default browser through the
// paired extension when Tasks > Web Use says so and it is connected, otherwise Off Grid AI's
// own browser. A task a paired browser started in one of its tabs runs in that browser and that
// tab, whatever the setting: the tab travels with its task (browser-start-tab.ts). Wiring only; the choice is web-use-target.ts (tested).

import { defaultBrowserTarget } from '../accessibility/ax-host'
import { getBrowserLinks } from '../extension-bridge/bridge-electron'
import { getWebUseSettings } from '../web-use-settings'
import { DEFAULT_BROWSER_FALLBACK_NOTE } from '../../shared/web-use-settings'
import { getBrowserRailHost } from './browser-host'
import type { BrowserRailHost } from './browser-rail'
import { createExtensionBrowserHost } from './extension-browser-host'
import { pickBrowserLink } from './web-use-target'

export function getWebUseRailHost(): BrowserRailHost {
  return {
    async runTask(request) {
      const { browserTarget } = getWebUseSettings()
      const links = getBrowserLinks()
      // A chat that offered its own tab is asking about that page, with its sign-ins: the offer
      // wins over the general setting, which decides only for tasks nobody pointed anywhere.
      const offered = request.startTab
      const offeredLink = offered
        ? links.find((l) => l.browser.id === offered.browserId)
        : undefined
      if (offered && offeredLink) {
        return createExtensionBrowserHost(() => offeredLink, offered.tabId).runTask(request)
      }
      const defaultName =
        browserTarget === 'default_browser' && links.length > 1
          ? ((await defaultBrowserTarget().catch(() => null))?.name ?? null)
          : null
      const link = pickBrowserLink(browserTarget, links, defaultName)
      if (link) return createExtensionBrowserHost(() => link).runTask(request)
      // The default browser was chosen but none is connected: run here, and say so on the task.
      return getBrowserRailHost().runTask(
        browserTarget === 'default_browser'
          ? { ...request, notice: DEFAULT_BROWSER_FALLBACK_NOTE }
          : request
      )
    }
  }
}
