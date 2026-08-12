// @vitest-environment jsdom
//
// P0 #137 - Core locked Pro tabs.
//
// This mounts the real App, navigation, Pro catalogue, entitlement loader, and
// UpgradeScreen. Only the preload/browser boundary is faked. The entitlement
// value is the production renderer boundary populated from OFFGRID_PRO=0 by main.

import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { getRegisteredNav } from '../bootstrap/navRegistry'
import { getRegisteredScreens } from '../bootstrap/screenRegistry'
import { getRegisteredSettingsSections } from '../bootstrap/sectionRegistry'
import { getSlot, SLOTS } from '../bootstrap/slotRegistry'
import { PRO_FEATURES } from '../components/pro/proCatalog'
import { PRO_PURCHASE_URL } from '@offgrid/core/shared/product-links'
import {
  installAppBoundary,
  installAppBrowserBoundary,
  installAppStorage
} from './harness/app-boundary'

let App: typeof import('../App').default

describe('<App/> locked Pro navigation integration', () => {
  beforeAll(async () => {
    installAppBoundary()
    installAppBrowserBoundary()
    ;({ default: App } = await import('../App'))
  }, 30_000)

  beforeEach(() => {
    installAppStorage().setItem('onboarding_completed', 'true')
    window.history.replaceState(null, '', '/models')
    installAppBrowserBoundary()
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  it('keeps every Pro route visible-but-locked and sends it through the one upgrade journey', async () => {
    const user = userEvent.setup()
    const openExternal = vi.fn()
    const onNewApproval = vi.fn(() => () => {})
    const onNewAction = vi.fn(() => () => {})
    const proOn = vi.fn(() => () => {})
    const proInvoke = vi.fn()
    installAppBoundary({
      isPro: false,
      openExternal,
      onNewApproval,
      onNewAction,
      proOn,
      proInvoke
    })

    render(<App />)
    // The sidebar opens expanded, so the labels this test reads are already on screen and there is no
    // "Expand sidebar" control to click - it exists only on the collapsed rail. Assert the expanded state
    // rather than assuming it, so a change of default fails here with the reason rather than as a
    // missing-label mystery further down.
    expect(await screen.findByRole('button', { name: 'Collapse sidebar' })).toBeTruthy()
    const navigation = screen.getByRole('navigation', { name: 'Primary navigation' })

    for (const feature of PRO_FEATURES) {
      const label = within(navigation).getByText(feature.label)
      const navButton = label.closest('button')
      expect(navButton).not.toBeNull()
      expect(within(navButton!).getByTitle('Pro')).not.toBeNull()

      await user.click(navButton!)

      expect(await screen.findByRole('heading', { name: feature.label, level: 1 })).not.toBeNull()
      expect(screen.getAllByRole('button', { name: /Get Pro/ })).toHaveLength(1)
      expect(screen.getAllByText('Everything in Pro')).toHaveLength(1)
      expect(window.location.pathname).toBe(`/${feature.route}`)
    }

    await user.click(screen.getByRole('button', { name: /Get Pro/ }))
    expect(openExternal).toHaveBeenCalledOnce()
    expect(openExternal).toHaveBeenCalledWith(PRO_PURCHASE_URL)

    await waitFor(() => {
      expect(getRegisteredNav()).toEqual([])
      expect(getRegisteredScreens()).toEqual([])
      expect(getRegisteredSettingsSections()).toEqual([])
      expect(getSlot(SLOTS.appRoot)).toBeUndefined()
      expect(getSlot(SLOTS.composerToolMenu)).toBeUndefined()
    })
    expect(onNewApproval).not.toHaveBeenCalled()
    expect(onNewAction).not.toHaveBeenCalled()
    expect(proOn).not.toHaveBeenCalled()
    expect(proInvoke).not.toHaveBeenCalled()
  }, 30_000)
})
