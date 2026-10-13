// Which browser a web task runs in. The browser hosts, the live links and the settings are the
// boundaries replaced; the choice itself (web-use-target.ts) runs for real.
import { beforeEach, describe, expect, it, vi } from 'vitest'

const world = vi.hoisted(() => ({
  target: 'default_browser' as 'in_app' | 'default_browser',
  links: [] as Array<{ browser: { id: string; name: string } }>,
  inApp: vi.fn(),
  extension: vi.fn(),
  tabs: [] as Array<number | undefined>
}))

vi.mock('../../web-use-settings', () => ({
  getWebUseSettings: () => ({ browserTarget: world.target })
}))
vi.mock('../../extension-bridge/bridge-electron', () => ({ getBrowserLinks: () => world.links }))
vi.mock('../../accessibility/ax-host', () => ({ defaultBrowserTarget: async () => null }))
vi.mock('../browser-host', () => ({ getBrowserRailHost: () => ({ runTask: world.inApp }) }))
vi.mock('../extension-browser-host', () => ({
  createExtensionBrowserHost: (_link: unknown, tabId?: number) => {
    world.tabs.push(tabId)
    return { runTask: world.extension }
  }
}))

import { getWebUseRailHost } from '../web-use-host'
import { DEFAULT_BROWSER_FALLBACK_NOTE } from '../../../shared/web-use-settings'

const request = { goal: 'Find the release notes', taskId: 'task-1', journeyId: 'journey-1' }

beforeEach(() => {
  world.target = 'default_browser'
  world.links = []
  world.tabs = []
  world.inApp.mockReset().mockResolvedValue({ ok: true })
  world.extension.mockReset().mockResolvedValue({ ok: true })
})

describe('web task browser choice', () => {
  it('runs here when the default browser is chosen but none is connected, and says so', async () => {
    await getWebUseRailHost().runTask(request)
    expect(world.extension).not.toHaveBeenCalled()
    expect(world.inApp).toHaveBeenCalledWith({ ...request, notice: DEFAULT_BROWSER_FALLBACK_NOTE })
  })

  it('runs in the connected browser when the default browser is chosen', async () => {
    world.links = [{ browser: { id: 'chrome-1', name: 'Chrome extension' } }]
    await getWebUseRailHost().runTask(request)
    expect(world.extension).toHaveBeenCalledWith(request)
    expect(world.inApp).not.toHaveBeenCalled()
  })

  it('adds no note when the Off Grid AI browser is the choice', async () => {
    world.target = 'in_app'
    world.links = [{ browser: { id: 'chrome-1', name: 'Chrome extension' } }]
    await getWebUseRailHost().runTask(request)
    expect(world.inApp).toHaveBeenCalledWith(request)
  })

  it('runs a task in the tab its own chat offered, whatever the setting', async () => {
    world.target = 'in_app'
    world.links = [{ browser: { id: 'chrome-1', name: 'Chrome extension' } }]
    await getWebUseRailHost().runTask({
      ...request,
      startTab: { browserId: 'chrome-1', tabId: 42 }
    })
    expect(world.tabs).toEqual([42])
    expect(world.inApp).not.toHaveBeenCalled()
  })
})
