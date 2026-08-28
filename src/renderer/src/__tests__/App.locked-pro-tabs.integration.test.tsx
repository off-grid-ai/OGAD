// @vitest-environment jsdom
//
// P0 #137 - Core locked Pro tabs.
//
// This mounts the real App, navigation, Pro catalogue, entitlement loader, and
// UpgradeScreen. Only the preload/browser boundary is faked. The entitlement
// value is the production renderer boundary populated from OFFGRID_PRO=0 by main.

import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { getRegisteredNav } from '../bootstrap/navRegistry'
import { getRegisteredScreens } from '../bootstrap/screenRegistry'
import { getRegisteredSettingsSections } from '../bootstrap/sectionRegistry'
import { getSlot, SLOTS } from '../bootstrap/slotRegistry'
import { registerProView } from '../bootstrap/proView'
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
    const onNewAction = vi.fn(() => () => {})
    const proOn = vi.fn(() => () => {})
    const proInvoke = vi.fn()
    installAppBoundary({
      isPro: false,
      openExternal,
      onNewAction,
      proOn,
      proInvoke
    })

    render(<App />)
    // The sidebar is a collapsed rail until the user points at it. Exercise the
    // production hover interaction before reading its labels.
    const navigation = await screen.findByRole('navigation', { name: 'Primary navigation' })
    expect(navigation.getAttribute('aria-expanded')).toBe('false')
    await user.hover(navigation)
    await waitFor(() => expect(navigation.getAttribute('aria-expanded')).toBe('true'))

    for (const feature of PRO_FEATURES) {
      if (!within(navigation).queryByText(feature.label)) {
        const closedGroups = Array.from(
          navigation.querySelectorAll<HTMLButtonElement>('button[aria-expanded="false"]')
        )
        for (const group of closedGroups) {
          await user.click(group)
          if (within(navigation).queryByText(feature.label)) break
        }
      }
      const label = within(navigation).getByText(feature.label)
      const navButton = label.closest('button')
      expect(navButton).not.toBeNull()
      expect(within(navButton!).getByTitle('Pro')).not.toBeNull()

      await user.click(navButton!)

      expect(await screen.findByRole('heading', { name: feature.label, level: 1 })).not.toBeNull()
      expect(screen.getAllByRole('button', { name: /Get Pro/ })).toHaveLength(1)
      expect(screen.getAllByText('Everything in Pro')).toHaveLength(1)
      expect(window.location.pathname).toBe(`/${feature.route}`)

      // Route changes rerender the shell. Restore the production hover state
      // before inspecting the next navigation label.
      await user.hover(navigation)
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
    expect(onNewAction).not.toHaveBeenCalled()
    expect(proOn).not.toHaveBeenCalled()
    expect(proInvoke).not.toHaveBeenCalled()
  }, 30_000)

  it('unmounts the open Pro screen and shows the purchase screen when the license expires', async () => {
    let publishLicense: ((info: ProLicenseInfo) => void) | undefined
    window.history.replaceState(null, '', '/day')
    installAppBoundary({
      isPro: true,
      license: {
        status: async () => ({
          isPro: true,
          tier: 'pro',
          expiry: null,
          verifiedAt: Date.now()
        }),
        onChanged: (listener: (info: ProLicenseInfo) => void) => {
          publishLicense = listener
          return () => {
            publishLicense = undefined
          }
        }
      }
    })
    // Vitest maps the private renderer package to the production free-build
    // stub. Register the paid-package boundary through the same public seam the
    // packaged Pro build uses, then test the real App gate around it.
    registerProView((view) => (view === 'day' ? <h1>Today</h1> : null))

    render(<App />)
    expect(await screen.findByRole('heading', { name: 'Today' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Get Pro/ })).toBeNull()

    act(() => {
      publishLicense?.({
        isPro: false,
        tier: null,
        expiry: '2026-08-25T12:00:00.000Z',
        verifiedAt: Date.now()
      })
    })

    expect(await screen.findByRole('heading', { name: 'Day' })).toBeTruthy()
    expect(screen.getByRole('button', { name: /Get Pro/ })).toBeTruthy()
    expect(screen.queryByRole('heading', { name: 'Today' })).toBeNull()
    await waitFor(() => expect(window.location.pathname).toBe('/day'))
  }, 30_000)
})
