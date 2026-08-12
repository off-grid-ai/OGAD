// @vitest-environment jsdom
//
// Open-core seam test (D31): the core Settings screen renders its pro sections
// through the section REGISTRY, not hardcoded pro components. Proven by driving a
// FAKE section through the same `registerSettingsSection` interface the pro package
// uses — if core ever went back to branching on `isPro` with the real sections
// inlined, the fake would not appear and this test would fail.
//
//   - Free build (nothing registered) → Capture & processing explains the Pro gap.
//   - Pro build (capture registered) → the Pro contribution and core processing
//     controls share the same Settings detail.
//
// resetModules per test so the freshly-imported Settings and sectionRegistry share
// one registry instance (the registry is a module singleton).
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, cleanup, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

function stubApi(platform = 'darwin'): void {
  const api = new Proxy(
    {},
    {
      get: (_t, prop) => {
        if (prop === 'isPro') return true
        if (prop === 'platform') return platform
        if (prop === 'license') return { status: () => Promise.resolve({}) }
        if (prop === 'getAppVersion') return () => Promise.resolve('')
        if (prop === 'getPermissionStatus') {
          return () =>
            Promise.resolve({
              accessibility: true,
              screenRecording: false,
              localNetwork: true,
              allGranted: false
            })
        }
        if (prop === 'getLlmSettings') {
          return () => Promise.resolve({ performanceMode: 'balanced' })
        }
        if (prop === 'setupPlan') return () => Promise.resolve(null)
        if (prop === 'systemHealth') {
          return () => Promise.resolve({ components: [], ramGb: 0, activeModel: null })
        }
        if (prop === 'getStorageInfo') return () => Promise.resolve(null)
        if (prop === 'listDownloads') return () => Promise.resolve([])
        if (prop === 'onSetupProgress' || prop === 'onModelProgress') return () => () => {}
        if (prop === 'queueConfigGet') {
          return () => Promise.resolve({ enabled: true, tier1Coexists: true })
        }
        if (prop === 'queueState') return () => Promise.resolve({ running: [], queued: [] })
        if (prop === 'residencyGet') return () => Promise.resolve({})
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
  it('free build explains capture availability inside the combined processing detail', async () => {
    vi.resetModules()
    stubApi()
    const { Settings } = await import('../Settings')
    const user = userEvent.setup()
    render(<Settings />)

    await user.click(screen.getByText('Capture & processing'))
    expect(
      await screen.findByText(/screen capture, backlog recovery, and proactive delivery/i)
    ).toBeTruthy()
    expect(screen.getByText('Processing priority')).toBeTruthy()
    expect(screen.getByText('Chat and capture model')).toBeTruthy()
    expect(screen.queryByTestId('fake-capture')).toBeNull()
  })

  it('pro build composes the registered capture owner with shared processing controls', async () => {
    vi.resetModules()
    stubApi()
    const { registerSettingsSection } = await import('../../bootstrap/sectionRegistry')
    registerSettingsSection({
      id: 'capture',
      component: () => <div data-testid="fake-capture">FAKE CAPTURE SECTION</div>
    })
    const { Settings } = await import('../Settings')
    const user = userEvent.setup()
    render(<Settings />)

    await user.click(screen.getByText('Capture & processing'))
    await waitFor(() => expect(screen.getByTestId('fake-capture')).toBeTruthy())
    expect(screen.getByText('Processing priority')).toBeTruthy()
    expect(screen.getByText('Chat and capture model')).toBeTruthy()
    expect(
      screen.queryByText(/screen capture, backlog recovery, and proactive delivery/i)
    ).toBeNull()
  })

  it('opens permission recovery at the end of Setup & health instead of adding another card', async () => {
    vi.resetModules()
    stubApi()
    const consumed = vi.fn()
    const { Settings } = await import('../Settings')
    render(<Settings initialSection="permissions" onInitialSectionConsumed={consumed} />)

    expect(await screen.findByText('System permissions')).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'Screen Recording' })).toBeTruthy()
    expect(screen.getByText('Permission needed')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Permissions' })).toBeNull()
    await waitFor(() => expect(consumed).toHaveBeenCalledOnce())
  })

  it('Windows Pro build withholds native capture while keeping account sections available', async () => {
    vi.resetModules()
    stubApi('win32')
    const { registerSettingsSection } = await import('../../bootstrap/sectionRegistry')
    registerSettingsSection({
      id: 'identity',
      component: () => <div data-testid="fake-identity">FAKE IDENTITY SECTION</div>
    })
    registerSettingsSection({
      id: 'capture',
      component: () => <div data-testid="fake-capture">FAKE CAPTURE SECTION</div>
    })

    const { Settings } = await import('../Settings')
    const user = userEvent.setup()
    render(<Settings />)

    await waitFor(() => expect(screen.getByTestId('fake-identity')).toBeTruthy())
    await user.click(screen.getByText('Capture & processing'))
    expect(screen.queryByTestId('fake-capture')).toBeNull()
    expect(
      screen.getByText(/screen capture, backlog recovery, and proactive delivery/i)
    ).toBeTruthy()
    expect(screen.getByText('Processing priority')).toBeTruthy()
  })
})
