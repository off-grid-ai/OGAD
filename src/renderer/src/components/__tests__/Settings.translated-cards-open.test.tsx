// @vitest-environment jsdom
// A Settings card opens by its shown title, which is in the app language. A Dutch tester could open only the
// cards whose title reads the same in Dutch (Sync, Engines, Model settings); every translated card stayed
// shut. The real Dutch catalog and the real Settings screen; window.api is the boundary, stubbed.
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { setCatalog, type Strings } from '@offgrid/i18n'
import nl from '../../../../../node_modules/@offgrid/i18n/catalogs/nl/desktop.json'

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
        if (prop === 'getRemoteVisionServer') {
          return () =>
            Promise.resolve({ provider: 'local', endpoint: '', model: '', hasApiKey: false })
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
  ;(window as unknown as { api: unknown }).api = api
}

afterEach(() => {
  cleanup()
  vi.resetModules()
  setCatalog('en', null)
})

describe('Settings in Dutch', () => {
  it('a card with a translated title opens its section', async () => {
    stubApi()
    setCatalog('nl', nl as Strings)
    const { Settings } = await import('../Settings')
    function Host(): React.JSX.Element {
      const [section, setSection] = useState<string | null>(null)
      return (
        <>
          <output data-testid="section">{String(section)}</output>
          <Settings activeSection={section} onSectionChange={setSection} />
        </>
      )
    }
    render(<Host />)
    await userEvent.setup().click(screen.getByText('Taal'))
    expect(screen.getByTestId('section').textContent).toBe('language')
  })
})
