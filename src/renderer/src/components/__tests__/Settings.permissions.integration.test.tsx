// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { modelControlBoundary } from './harness/model-control-snapshot'

function installDesktopBoundary(): void {
  const modelControl = modelControlBoundary({
    kinds: [],
    models: [] as Array<{ id: string }>
  })
  const api = new Proxy(modelControl, {
    get: (target, prop) => {
      const modelControlMember = Reflect.get(target, prop)
      if (modelControlMember !== undefined) return modelControlMember
      if (prop === 'isPro') return true
      if (prop === 'platform') return 'darwin'
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
      if (prop === 'getRemoteVisionServer') {
        return () =>
          Promise.resolve({
            provider: 'local',
            endpoint: '',
            model: '',
            hasApiKey: false,
            activeServerId: null,
            servers: []
          })
      }
      if (prop === 'setupPlan') {
        return () => Promise.resolve({ mode: 'balanced', ramGb: 16, items: [], totalDownloadGb: 0 })
      }
      if (prop === 'systemHealth') {
        return () => Promise.resolve({ components: [], ramGb: 0, activeModel: null })
      }
      if (prop === 'getStorageInfo') return () => Promise.resolve(null)
      if (prop === 'listDownloads') return () => Promise.resolve([])
      if (
        prop === 'onSetupProgress' ||
        prop === 'onModelProgress' ||
        prop === 'onChatHealthChanged'
      ) {
        return () => () => {}
      }
      if (prop === 'queueConfigGet') {
        return () => Promise.resolve({ enabled: true, tier1Coexists: true })
      }
      if (prop === 'queueState') return () => Promise.resolve({ running: [], queued: [] })
      if (prop === 'residencyGet') return () => Promise.resolve({})
      return () => Promise.resolve({})
    }
  })
  ;(window as unknown as { api: typeof api }).api = api
  vi.stubGlobal('__OFFGRID_PRO__', true)
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.resetModules()
})

describe('Settings permission recovery', () => {
  it('opens permission recovery at the end of Setup & health instead of adding another card', async () => {
    vi.resetModules()
    installDesktopBoundary()
    const consumed = vi.fn()
    const { Settings } = await import('../Settings')
    render(<Settings initialSection="permissions" onInitialSectionConsumed={consumed} />)

    expect(await screen.findByText('System permissions')).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'Screen Recording' })).toBeTruthy()
    expect(await screen.findByText('Permission needed')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Permissions' })).toBeNull()
    await waitFor(() => expect(consumed).toHaveBeenCalledOnce())
  })
})
