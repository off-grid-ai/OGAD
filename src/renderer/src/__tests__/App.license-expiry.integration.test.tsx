// @vitest-environment jsdom

import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { callHook } from '../bootstrap/hookRegistry'
import { clearProFeaturesRenderer } from '../bootstrap/loadProFeaturesRenderer'
import { getRegisteredNav } from '../bootstrap/navRegistry'
import { renderProView, type ProViewContext } from '../bootstrap/proView'
import { getRegisteredScreens } from '../bootstrap/screenRegistry'
import { getRegisteredSettingsSections } from '../bootstrap/sectionRegistry'
import { getSlot, SLOTS } from '../bootstrap/slotRegistry'
import { NOTIFICATION_METADATA_HOOK } from '../lib/notification-hooks'
import { TooltipProvider } from '../components/ui/tooltip'
import {
  installAppBoundary,
  installAppBrowserBoundary,
  installAppStorage
} from './harness/app-boundary'

// Vitest maps the private package to the open-core stub. Redirect that test
// boundary to the real checked-out Pro renderer so this journey exercises its
// production activation and cleanup, not a local fake.
vi.mock('@offgrid/pro/renderer', async () => import('../../../../pro/renderer/index'))

let App: typeof import('../App').default

interface LicenseBoundary {
  emit: (info: ProLicenseInfo) => void
  subscriptionStops: ReturnType<typeof vi.fn>[]
}

function installLicenseBoundary({
  initialIsPro,
  status
}: {
  initialIsPro: boolean
  status: ProLicenseInfo
}): LicenseBoundary {
  let changed: ((info: ProLicenseInfo) => void) | null = null
  const subscriptionStops: ReturnType<typeof vi.fn>[] = []
  const proOn = vi.fn(() => {
    const stop = vi.fn()
    subscriptionStops.push(stop)
    return stop
  })
  const onChanged = vi.fn((callback: (info: ProLicenseInfo) => void) => {
    changed = callback
    const stop = vi.fn()
    subscriptionStops.push(stop)
    return stop
  })
  installAppBoundary({
    isPro: initialIsPro,
    proEntitlementBootstrapEnabled: false,
    proOn,
    license: {
      status: async () => status,
      activate: async () => ({ ok: false, reason: 'invalid_credential' }),
      listDevices: async () => [],
      deactivate: async () => false,
      resetCurrentDevice: async () => false,
      clear: async () => {},
      payUrl: async () => 'https://getoffgridai.co/pro/',
      openPay: async () => {},
      relaunch: async () => {},
      onChanged
    }
  })
  return {
    emit: (info) => changed?.(info),
    subscriptionStops
  }
}

function proViewContext(): ProViewContext {
  return {} as ProViewContext
}

function renderApp(): ReturnType<typeof render> {
  // App is mounted below this provider in the production renderer entry point.
  return render(
    <TooltipProvider>
      <App />
    </TooltipProvider>
  )
}

describe('<App/> live Pro entitlement integration', () => {
  beforeAll(async () => {
    installAppBoundary()
    installAppBrowserBoundary()
    await import('@offgrid/pro/renderer')
    ;({ default: App } = await import('../App'))
  }, 30_000)

  beforeEach(() => {
    installAppStorage().setItem('onboarding_completed', 'true')
    installAppBrowserBoundary()
    clearProFeaturesRenderer()
  })

  afterEach(() => {
    cleanup()
    clearProFeaturesRenderer()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  afterAll(() => {
    clearProFeaturesRenderer()
  })

  it('removes paid capabilities and forces purchase when foreground validation revokes active chat', async () => {
    window.history.replaceState(null, '', '/chat')
    const boundary = installLicenseBoundary({
      initialIsPro: true,
      status: { isPro: true, tier: 'monthly', expiry: '2030-01-01T00:00:00.000Z', verifiedAt: 1 }
    })
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)

    renderApp()

    await waitFor(() => {
      expect(getRegisteredSettingsSections().length).toBeGreaterThan(0)
      expect(getSlot(SLOTS.connectorSetup)).toBeDefined()
      expect(renderProView('day', proViewContext())).not.toBeNull()
      expect(callHook(NOTIFICATION_METADATA_HOOK, { source: 'action', recordId: 1 })).toBeTruthy()
    })
    expect(window.location.pathname).toBe('/chat')

    act(() => {
      boundary.emit({
        isPro: false,
        tier: null,
        expiry: '2026-08-01T00:00:00.000Z',
        verifiedAt: 2
      })
    })

    // Registry removal is synchronous with the authoritative event. React does
    // not get one more paid render or hook call while it changes screens.
    expect(getRegisteredNav()).toEqual([])
    expect(getRegisteredScreens()).toEqual([])
    expect(getRegisteredSettingsSections()).toEqual([])
    expect(getSlot(SLOTS.connectorSetup)).toBeUndefined()
    expect(renderProView('day', proViewContext())).toBeNull()
    expect(callHook(NOTIFICATION_METADATA_HOOK, { source: 'action', recordId: 1 })).toBeUndefined()

    expect(await screen.findByRole('heading', { name: 'Day', level: 1 })).not.toBeNull()
    expect(screen.getAllByRole('button', { name: /Get Pro/ })).toHaveLength(1)
    expect(window.location.pathname).toBe('/day')
    expect(confirm).not.toHaveBeenCalled()
    await waitFor(() => {
      expect(boundary.subscriptionStops.some((stop) => stop.mock.calls.length > 0)).toBe(true)
    })

    // The preload snapshot is deliberately still true. Opening a core screen
    // proves nested renderer capabilities now use the live projection instead.
    const user = userEvent.setup()
    const navigation = screen.getByRole('navigation', { name: 'Primary navigation' })
    await user.click(within(navigation).getByRole('button', { name: 'Settings' }))
    expect(await screen.findByText('Personalization & automation unlock with Pro')).not.toBeNull()
  }, 30_000)

  it('forces purchase on a cold start whose cached monthly expiry already passed', async () => {
    window.history.replaceState(null, '', '/models')
    installLicenseBoundary({
      initialIsPro: false,
      status: {
        isPro: false,
        tier: null,
        expiry: '2026-08-01T00:00:00.000Z',
        verifiedAt: 10
      }
    })

    renderApp()

    expect(await screen.findByRole('heading', { name: 'Day', level: 1 })).not.toBeNull()
    expect(screen.getAllByRole('button', { name: /Get Pro/ })).toHaveLength(1)
    expect(window.location.pathname).toBe('/day')
  })

  it('keeps lifetime access active and leaves a first-time free install on Models', async () => {
    window.history.replaceState(null, '', '/day')
    const lifetime = installLicenseBoundary({
      initialIsPro: true,
      status: { isPro: true, tier: 'lifetime', expiry: null, verifiedAt: 20 }
    })
    const first = renderApp()

    await waitFor(() => expect(renderProView('day', proViewContext())).not.toBeNull())
    act(() => {
      lifetime.emit({ isPro: true, tier: 'lifetime', expiry: null, verifiedAt: 21 })
    })
    expect(renderProView('day', proViewContext())).not.toBeNull()
    expect(screen.queryByRole('button', { name: /Get Pro/ })).toBeNull()

    first.unmount()
    clearProFeaturesRenderer()
    window.history.replaceState(null, '', '/models')
    installLicenseBoundary({
      initialIsPro: false,
      status: { isPro: false, tier: null, expiry: null, verifiedAt: 0 }
    })
    renderApp()

    expect(await screen.findByRole('heading', { name: 'Models' })).not.toBeNull()
    expect(window.location.pathname).toBe('/models')
    expect(screen.queryByRole('button', { name: /Get Pro/ })).toBeNull()
  }, 30_000)
})
