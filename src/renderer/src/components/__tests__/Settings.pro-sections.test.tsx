// @vitest-environment jsdom
//
// Open-core seam test (D31): the core Settings screen renders its pro sections
// through the section REGISTRY, not hardcoded pro components. Proven by driving a
// FAKE section through the same `registerSettingsSection` interface the pro package
// uses — if core ever went back to branching on `isPro` with the real sections
// inlined, the fake would not appear and this test would fail.
//
//   - Free build (nothing registered) → the catalogued ProPlaceholder shows.
//   - Pro build (a section registered for a slot id) → the registered component
//     renders in that slot, and the placeholder is gone.
//
// resetModules per test so the freshly-imported Settings and sectionRegistry share
// one registry instance (the registry is a module singleton).
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, cleanup, waitFor, act } from '@testing-library/react'

function stubApi(platform = 'darwin'): void {
  const api = new Proxy(
    {},
    {
      get: (_t, prop) => {
        if (prop === 'isPro') return true
        if (prop === 'platform') return platform
        if (prop === 'license') return { status: () => Promise.resolve({}) }
        if (prop === 'getAppVersion') return () => Promise.resolve('')
        return () => Promise.resolve({})
      }
    }
  )
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(window as any).api = api
  vi.stubGlobal('__OFFGRID_PRO__', true)
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.resetModules()
})

describe('Settings pro-section registry seam (D31)', () => {
  it('free build (registry empty): shows the catalogued ProPlaceholder for a pro slot', async () => {
    vi.resetModules()
    stubApi()
    const { Settings } = await import('../Settings')
    render(<Settings />)
    // The proactive slot's PLACEHOLDER copy (from proSettingsCatalog) is on screen...
    await waitFor(() =>
      expect(screen.getByText(/native notifications, even when the window is closed/i)).toBeTruthy()
    )
    // ...and no section was registered to replace it.
    expect(screen.queryByTestId('fake-proactive')).toBeNull()
  })

  it('pro build: a section registered for the slot id renders instead of the placeholder', async () => {
    vi.resetModules()
    stubApi()
    // Register a FAKE section through the SAME interface the pro package uses.
    const { registerSettingsSection } = await import('../../bootstrap/sectionRegistry')
    registerSettingsSection({
      id: 'proactive',
      component: () => <div data-testid="fake-proactive">FAKE PROACTIVE SECTION</div>
    })
    const { Settings } = await import('../Settings')
    render(<Settings />)
    // The registered component renders in the slot...
    await waitFor(() => expect(screen.getByTestId('fake-proactive')).toBeTruthy())
    // ...and the placeholder for that slot is gone.
    expect(screen.queryByText(/native notifications, even when the window is closed/i)).toBeNull()
  })

  it('reactively renders a core package section without a Pro catalog slot', async () => {
    vi.resetModules()
    stubApi()
    const registry = await import('../../bootstrap/sectionRegistry')
    const { Settings } = await import('../Settings')
    render(<Settings />)
    expect(screen.queryByTestId('fake-sync-settings')).toBeNull()

    act(() => {
      registry.registerCoreSettingsSection({
        id: 'sync',
        component: () => <div data-testid="fake-sync-settings">SYNC SETTINGS</div>
      })
    })

    await waitFor(() => expect(screen.getByTestId('fake-sync-settings')).toBeTruthy())
  })

  it('Windows Pro build: withholds Mac-only sections but keeps account sections available', async () => {
    vi.resetModules()
    stubApi('win32')
    const { registerSettingsSection } = await import('../../bootstrap/sectionRegistry')
    registerSettingsSection({
      id: 'identity',
      component: () => <div data-testid="fake-identity">FAKE IDENTITY SECTION</div>
    })
    registerSettingsSection({
      id: 'proactive',
      component: () => <div data-testid="fake-proactive">FAKE PROACTIVE SECTION</div>
    })

    const { Settings } = await import('../Settings')
    render(<Settings />)

    await waitFor(() => expect(screen.getByTestId('fake-identity')).toBeTruthy())
    expect(screen.queryByTestId('fake-proactive')).toBeNull()
    expect(
      screen.getByText(/morning briefings and meeting alerts are available on Mac/i)
    ).toBeTruthy()
    expect(screen.getAllByText('Coming soon').length).toBeGreaterThan(0)
  })
})
