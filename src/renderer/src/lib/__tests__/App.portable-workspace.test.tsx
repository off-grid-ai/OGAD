// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

function installBrowserBoundaries(): void {
  const values = new Map<string, string>([['onboarding_completed', 'true']])
  vi.stubGlobal('localStorage', {
    get length() {
      return values.size
    },
    clear: () => values.clear(),
    getItem: (key: string) => values.get(key) ?? null,
    key: (index: number) => [...values.keys()][index] ?? null,
    removeItem: (key: string) => values.delete(key),
    setItem: (key: string, value: string) => values.set(key, value)
  })
  Object.assign(window, {
    matchMedia: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => undefined,
      removeListener: () => undefined,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      dispatchEvent: () => true
    })
  })
}

function installPreloadBoundary(): void {
  const api = new Proxy(
    {
      isPro: false,
      platform: 'darwin',
      sync: {
        summary: vi.fn().mockResolvedValue({
          projects: 1,
          conversations: 2,
          messages: 5,
          documents: 3,
          attachments: 4
        }),
        exportAll: vi.fn().mockResolvedValue({ canceled: false, savedPath: '/chosen/archive.zip' }),
        exportProject: vi.fn(),
        exportConversation: vi.fn(),
        importPicker: vi.fn().mockResolvedValue({
          projectsAdded: 1,
          projectsUpdated: 0,
          conversationsAdded: 2,
          conversationsUpdated: 0,
          messagesAdded: 5,
          messagesUpdated: 0,
          documentsAdded: 3,
          documentsUpdated: 0,
          attachmentsImported: 4,
          skipped: 0,
          warnings: []
        })
      },
      getPermissionStatus: async () => ({ allGranted: true }),
      checkModelStatus: async () => ({ downloaded: true, modelsDir: '/models' }),
      getModelCatalog: async () => ({ kinds: [], models: [] }),
      getInstalledModels: async () => [],
      getActiveModelIds: async () => [],
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
  vi.stubGlobal('__OFFGRID_PRO__', false)
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('App portable workspace composition', () => {
  it('renders and operates the real package screen through the registered host port', async () => {
    installBrowserBoundaries()
    installPreloadBoundary()
    window.history.replaceState(null, '', '/')
    const [{ default: App }, { registerPortableWorkspace }] = await Promise.all([
      import('../../App'),
      import('../../features/portable-workspace/register')
    ])
    const unregister = registerPortableWorkspace()
    const user = userEvent.setup()

    render(<App />)
    await user.click(await screen.findByTitle('Workspace transfer'))
    await screen.findByRole('heading', { name: 'Take your workspace with you.' })
    await waitFor(() =>
      expect(screen.getByLabelText('Workspace contents').textContent).toContain(
        'PROJECTS1CONVERSATIONS2DOCUMENTS3ATTACHMENTS4'
      )
    )
    expect((screen.getByRole('combobox') as HTMLSelectElement).disabled).toBe(true)
    expect(screen.getByRole('option').textContent).toBe('Keep existing')

    await user.click(screen.getByRole('button', { name: 'EXPORT WORKSPACE' }))
    await screen.findByText('Exported 15 workspace items.')
    expect(vi.mocked(window.api.sync.exportAll)).toHaveBeenCalledOnce()

    await user.click(screen.getByRole('button', { name: 'IMPORT WORKSPACE' }))
    await screen.findByText('Imported 15 workspace items.')
    expect(vi.mocked(window.api.sync.importPicker)).toHaveBeenCalledWith()

    await user.click(screen.getByRole('button', { name: 'Settings' }))
    await screen.findByRole('heading', { name: 'Move your Off Grid AI workspace' })

    act(() => unregister())
  })
})
