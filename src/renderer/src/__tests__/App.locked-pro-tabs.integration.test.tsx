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
import { getSlot, registerSlot, SLOTS } from '../bootstrap/slotRegistry'
import { clearProFeaturesRenderer } from '../bootstrap/loadProFeaturesRenderer'
import { registerProView } from '../bootstrap/proView'
import { PRO_FEATURES } from '../components/pro/proCatalog'
import { TooltipProvider } from '../components/ui/tooltip'
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
    clearProFeaturesRenderer()
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

    // Wrapped as main.tsx wraps the app.
    render(
      <TooltipProvider>
        <App />
      </TooltipProvider>
    )
    // The sidebar is a collapsed rail until the user points at it. Exercise the
    // production hover interaction before reading its labels.
    const navigation = await screen.findByRole('navigation', { name: 'Primary navigation' })
    expect(navigation.getAttribute('aria-expanded')).toBe('false')
    await user.hover(navigation)
    await waitFor(() => expect(navigation.getAttribute('aria-expanded')).toBe('true'))

    // The God is open to everyone (its prepared workflows stay Pro); every other Pro route
    // is visible but locked.
    for (const feature of PRO_FEATURES.filter((f) => f.route !== 'explore')) {
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

    // Wrapped as main.tsx wraps the app.
    render(
      <TooltipProvider>
        <App />
      </TooltipProvider>
    )
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

  it('offers Day on Linux to a free user', async () => {
    window.history.replaceState(null, '', '/day')
    const openExternal = vi.fn()
    installAppBoundary({ platform: 'linux', isPro: false, openExternal })

    // Wrapped as main.tsx wraps the app.
    render(
      <TooltipProvider>
        <App />
      </TooltipProvider>
    )

    expect(await screen.findByRole('heading', { name: 'Day' })).toBeTruthy()
    expect(screen.getByText(/Off Grid AI Pro · Available now/)).toBeTruthy()
    expect(screen.queryByText(/This feature is coming soon to Linux/)).toBeNull()
    expect(screen.getByRole('button', { name: /Get Pro/ })).toBeTruthy()
    expect(openExternal).not.toHaveBeenCalled()
  }, 30_000)

  it('offers Vault from its Linux route', async () => {
    window.history.replaceState(null, '', '/vault')
    installAppBoundary({ platform: 'linux', isPro: false })

    // Wrapped as main.tsx wraps the app.
    render(
      <TooltipProvider>
        <App />
      </TooltipProvider>
    )

    expect(await screen.findByRole('heading', { name: 'Vault' })).toBeTruthy()
    expect(screen.getByText(/Off Grid AI Pro · Available now/)).toBeTruthy()
    expect(screen.getByRole('button', { name: /Get Pro/ })).toBeTruthy()
    expect(screen.queryByText(/coming soon to Linux/i)).toBeNull()
  }, 30_000)

  it('unlocks the ported routes for an entitled Linux user', async () => {
    const user = userEvent.setup()
    installAppBoundary({ platform: 'linux', isPro: true })
    const paidView = (view: string): React.JSX.Element => <h1>Paid {view}</h1>
    const taskWorkspace = (): React.JSX.Element => <h1>Paid Tasks workspace</h1>
    registerProView(paidView)
    registerSlot(SLOTS.taskWorkspace, taskWorkspace)
    // God's screen comes from Pro, like the other paid screens here.
    registerSlot(SLOTS.godScreen, () => <h1>Paid God</h1>)

    // Wrapped as main.tsx wraps the app.
    render(
      <TooltipProvider>
        <App />
      </TooltipProvider>
    )
    const navigation = await screen.findByRole('navigation', { name: 'Primary navigation' })
    await user.hover(navigation)
    await waitFor(() => expect(navigation.getAttribute('aria-expanded')).toBe('true'))

    for (const feature of PRO_FEATURES) {
      const navButton = within(navigation).getByRole('button', { name: feature.label })
      expect(within(navButton).queryByTitle('Coming soon')).toBeNull()
      expect(within(navButton).queryByTitle('Pro')).toBeNull()
      await user.click(navButton)
      expect(
        await screen.findByRole('heading', {
          name:
            feature.route === 'tasks'
              ? 'Paid Tasks workspace'
              : feature.route === 'explore'
                ? 'Paid God'
                : `Paid ${feature.route}`
        })
      ).toBeTruthy()
      await user.hover(navigation)
    }
  }, 30_000)

  it('opens God for an entitled user when a route names it "god", as the sidebar does', async () => {
    installAppBoundary({ isPro: true })
    registerProView((view: string) => <h1>Paid {view}</h1>)
    registerSlot(SLOTS.godScreen, () => <h1>Paid God</h1>)
    render(
      <TooltipProvider>
        <App />
      </TooltipProvider>
    )
    await screen.findByRole('navigation', { name: 'Primary navigation' })

    act(() => {
      window.dispatchEvent(new CustomEvent('og:navigate', { detail: 'god' }))
    })
    expect(await screen.findByRole('heading', { name: 'Paid God' })).toBeTruthy()
    expect(screen.queryByText('Off Grid AI Pro is here')).toBeNull()
  }, 30_000)

  it('does not mark all Pro Settings cards as coming soon on Linux', async () => {
    window.history.replaceState(null, '', '/settings')
    installAppBoundary({ platform: 'linux', isPro: false })

    // Wrapped as main.tsx wraps the app.
    render(
      <TooltipProvider>
        <App />
      </TooltipProvider>
    )

    expect(await screen.findByRole('heading', { name: 'Settings' })).toBeTruthy()
    expect(
      screen.queryByText('Pro features are coming soon to Linux. Core features work now.')
    ).toBeNull()
  }, 30_000)
})
