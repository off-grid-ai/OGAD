// The one place web_use picks its browser for a task: the user's default browser through the
// paired extension when Tasks > Web Use says so and it is connected, otherwise Off Grid AI's
// own browser. Wiring only; the choice is web-use-target.ts (tested).

import { defaultBrowserTarget } from '../accessibility/ax-host'
import { getBrowserLinks } from '../extension-bridge/bridge-electron'
import { getWebUseSettings } from '../web-use-settings'
import { getBrowserRailHost } from './browser-host'
import type { BrowserRailHost } from './browser-rail'
import { createExtensionBrowserHost } from './extension-browser-host'
import { pickBrowserLink, pickRequestingLink } from './web-use-target'
import { startTabs } from '../extension-bridge/browser-start-tab'

export function getWebUseRailHost(): BrowserRailHost {
  return {
    async runTask(request) {
      const { browserTarget } = getWebUseSettings()
      const links = getBrowserLinks()
      const defaultName =
        browserTarget === 'default_browser' && links.length > 1
          ? ((await defaultBrowserTarget().catch(() => null))?.name ?? null)
          : null
      const link =
        pickRequestingLink(request.journeyId, links, startTabs.has) ??
        pickBrowserLink(browserTarget, links, defaultName)
      return link
        ? createExtensionBrowserHost(() => link).runTask(request)
        : getBrowserRailHost().runTask(request)
    }
  }
}
