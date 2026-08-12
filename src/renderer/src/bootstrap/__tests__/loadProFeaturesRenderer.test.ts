// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Which half of the app switches on at launch, and on whose word.
 *
 * Three outcomes, and confusing them is immediately visible to a user: a paying customer greeted by the
 * upgrade screen, a free build with Pro screens in the nav, or a device that can never be paired because
 * the one screen that pairs it never registered.
 *
 * That third case is the subtle one. A device with no licence yet still needs the ENTITLEMENT BOOTSTRAP
 * surface - the flow that claims a seat from another device - so "not entitled" cannot simply mean "load
 * nothing". These tests pin all three answers and every way each can fail.
 *
 * The pro package is the boundary: in a free build the Vite alias resolves it to a stub, which is why an
 * absent module is a supported outcome rather than an error.
 */

const pro = vi.hoisted(() => ({
  activateRenderer: undefined as unknown,
  activateEntitlementBootstrapRenderer: undefined as unknown
}))

// Re-established per test rather than declared once. vitest evaluates a mock factory a single time per
// module graph, so a hoisted factory keeps whatever the first test set; and the one test that needs the
// IMPORT ITSELF to fail cannot express that through a factory's return value. Both are handled by mocking
// inside beforeEach, after resetting the registry.
const mockProPackage = (): void => {
  vi.doMock('@offgrid/pro/renderer', () => ({
    get activateRenderer() {
      return pro.activateRenderer
    },
    get activateEntitlementBootstrapRenderer() {
      return pro.activateEntitlementBootstrapRenderer
    }
  }))
}

const setBridge = (bridge: Record<string, unknown>): void => {
  ;(window as unknown as { api: Record<string, unknown> }).api = bridge
}

describe('activating the licensed half of the renderer', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.restoreAllMocks()
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    pro.activateRenderer = undefined
    pro.activateEntitlementBootstrapRenderer = undefined
    setBridge({})
    mockProPackage()
  })

  const load = async (): Promise<string> => {
    const { loadProFeaturesRenderer } = await import('../loadProFeaturesRenderer')
    return loadProFeaturesRenderer()
  }

  it('activates everything for an entitled device, and hands over every registry it needs', async () => {
    const activate = vi.fn()
    pro.activateRenderer = activate
    setBridge({ isPro: true })

    await expect(load()).resolves.toBe('full')

    // All six registries, because each is a whole surface the user can otherwise not reach: a screen, its
    // nav entry, a slot inside a core screen, a Settings section, a hook, and the pro view router. A
    // missing one fails silently - nothing errors, the surface simply is not there.
    expect(activate).toHaveBeenCalledWith(
      expect.objectContaining({
        registerScreen: expect.any(Function),
        registerNav: expect.any(Function),
        registerSlot: expect.any(Function),
        registerSettingsSection: expect.any(Function),
        registerHook: expect.any(Function),
        registerProView: expect.any(Function)
      })
    )
  })

  it('loads nothing in a build with no pro package at all', async () => {
    setBridge({ isPro: true })
    // An import that THROWS - replacing this test's module only. The next test's beforeEach resets the
    // registry and re-mocks, so this does not leak (an unmock WOULD, by disabling the package for every
    // test that followed).
    vi.resetModules()
    vi.doMock('@offgrid/pro/renderer', () => {
      throw new Error('module not found')
    })

    // The free/contributor build: the alias resolves to a stub and the import throws. Not an error state -
    // it is the open-core seam working, so it must not surface as a failure to the user.
    await expect(load()).resolves.toBe('none')
  })

  it('loads nothing for a device that is not entitled and has no pairing flow offered', async () => {
    pro.activateRenderer = vi.fn()
    setBridge({ isPro: false })

    await expect(load()).resolves.toBe('none')
    expect(pro.activateRenderer).not.toHaveBeenCalled()
  })

  it('activates the pairing surface for an unentitled device when bootstrap is offered', async () => {
    const bootstrap = vi.fn()
    const full = vi.fn()
    pro.activateEntitlementBootstrapRenderer = bootstrap
    pro.activateRenderer = full
    setBridge({ isPro: false, proEntitlementBootstrapEnabled: true })

    await expect(load()).resolves.toBe('entitlement-bootstrap')

    // The narrow surface only. A device claiming a seat from another device needs the pairing screen and
    // nothing else; activating the full set here would show Pro features to someone who has not got them.
    expect(bootstrap).toHaveBeenCalledTimes(1)
    expect(full).not.toHaveBeenCalled()
  })

  it('stays off when bootstrap is offered but the package cannot provide it', async () => {
    pro.activateRenderer = vi.fn()
    setBridge({ isPro: false, proEntitlementBootstrapEnabled: true })

    // An older pro build that predates the pairing flow. Better to show the upgrade path than to call a
    // function that is not there and take the whole renderer down at launch.
    await expect(load()).resolves.toBe('none')
  })

  it('prefers the full activation over bootstrap once the device is entitled', async () => {
    const bootstrap = vi.fn()
    const full = vi.fn()
    pro.activateEntitlementBootstrapRenderer = bootstrap
    pro.activateRenderer = full
    setBridge({ isPro: true, proEntitlementBootstrapEnabled: true })

    await expect(load()).resolves.toBe('full')
    expect(bootstrap).not.toHaveBeenCalled()
    expect(full).toHaveBeenCalledTimes(1)
  })

  it('stays off when an entitled build has no activation function', async () => {
    setBridge({ isPro: true })

    // The stub resolved to null, or the package exports something unexpected. 'none' rather than a crash:
    // the core app still works without its licensed half.
    await expect(load()).resolves.toBe('none')
  })

  it('survives an activation that throws, rather than taking the app down with it', async () => {
    pro.activateRenderer = vi.fn(() => {
      throw new Error('a screen failed to register')
    })
    setBridge({ isPro: true })

    // A blank window is the worst outcome here. One broken pro surface must cost the user that surface, not
    // the whole app - and the failure is logged rather than swallowed.
    await expect(load()).resolves.toBe('none')
    expect(console.error).toHaveBeenCalledWith('[pro] activateRenderer failed', expect.any(Error))
  })

  it('treats a preload bridge that is not there as unentitled', async () => {
    pro.activateRenderer = vi.fn()
    ;(window as unknown as { api?: unknown }).api = undefined

    // Early in a launch, or a renderer loaded without the preload. Reading isPro off undefined would throw
    // before anything rendered; optional access means the app comes up free instead.
    await expect(load()).resolves.toBe('none')
  })
})
