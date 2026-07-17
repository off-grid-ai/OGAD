// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ComponentType } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

function installBrowserStorageBoundary(): void {
  const values = new Map<string, string>()
  const storage: Storage = {
    get length() {
      return values.size
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => values.delete(key),
    setItem: (key, value) => values.set(key, value)
  }
  vi.stubGlobal('localStorage', storage)
  const matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => undefined,
    removeListener: () => undefined,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => true
  })) as typeof window.matchMedia
  Object.assign(window, { matchMedia })
}

function installPreloadBoundary(): void {
  const api = new Proxy(
    {
      isPro: true,
      platform: 'darwin',
      getPermissionStatus: async () => ({ allGranted: true }),
      checkModelStatus: async () => ({ downloaded: true, modelsDir: '/models' }),
      getStagedUpdateVersion: async () => null,
      systemHealth: async () => ({ components: [] }),
      meetingGetState: async () => undefined
    },
    {
      get: (target, property: string) => {
        if (property in target) return target[property as keyof typeof target]
        if (property.startsWith('on')) return () => () => {}
        return async () => undefined
      }
    }
  )
  Object.assign(window, { api })
  vi.stubGlobal('__OFFGRID_PRO__', true)
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('App package feature composition', () => {
  it('reactively deep-links and navigates to an atomically registered core screen', async () => {
    installBrowserStorageBoundary()
    installPreloadBoundary()
    localStorage.setItem('onboarding_completed', 'true')
    window.history.replaceState(null, '', '/sync-shell-test')

    const [{ default: App }, { registerFeature }] = await Promise.all([
      import('../../App'),
      import('@renderer/bootstrap/featureRegistry')
    ])
    const user = userEvent.setup()
    render(<App />)
    await screen.findByTitle('Day')
    expect(screen.queryByTitle('Sync')).toBeNull()
    window.history.replaceState(null, '', '/sync-shell-test')

    const Icon = (() => null) as ComponentType<{ className?: string }>
    let unregister = (): void => {}
    act(() => {
      unregister = registerFeature({
        route: 'sync-shell-test',
        label: 'Sync',
        icon: Icon,
        component: () => <main>Connected devices</main>
      })
    })

    await waitFor(() => expect(screen.getByRole('main').textContent).toBe('Connected devices'))
    expect(window.location.pathname).toBe('/sync-shell-test')

    await user.click(screen.getByTitle('Day'))
    await waitFor(() => expect(screen.queryByRole('main')).toBeNull())
    await user.click(screen.getByTitle('Sync'))
    await waitFor(() => expect(screen.getByRole('main').textContent).toBe('Connected devices'))

    act(() => unregister())
    expect(screen.queryByTitle('Sync')).toBeNull()
    expect(screen.queryByRole('main')).toBeNull()
  })
})
