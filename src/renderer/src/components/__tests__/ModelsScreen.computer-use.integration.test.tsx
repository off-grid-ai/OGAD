// @vitest-environment jsdom

// Computer Use enters through the real Models screen and uses the same catalog projection, filters,
// installed/available sections, card actions, and progress state as every other model kind. Only the
// Electron IPC bridge is controlled because it is outside the renderer process.
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { CATALOG, MODEL_KINDS, modelsByKind } from '@offgrid/models'

const computerUseModels = modelsByKind('computer_use')
const uiMate = computerUseModels.find((model) => model.id === 'bartowski/tencent_UI-Mate-9B-GGUF')
const uiTars = computerUseModels.find((model) => model.id === 'mradermacher/UI-TARS-1.5-7B-GGUF')
if (!uiMate || !uiTars) throw new Error('Computer Use catalog fixtures are missing')

let activeIds: string[] = []
let activationRequests: Array<[string, string?]> = []

;(globalThis as unknown as { window: { api: unknown } }).window.api = {
  systemHealth: async () => ({ ramGb: 34 }),
  getModelControlSnapshot: async () => ({
    kinds: MODEL_KINDS,
    models: CATALOG,
    installed: [uiMate.id],
    activeIds,
    active: {
      text: null,
      image: null,
      speech: null,
      transcription: null,
      computer_use: activeIds[0] ?? null
    },
    computerUse: null
  }),
  getModelCatalog: async () => ({ kinds: MODEL_KINDS, models: CATALOG }),
  getInstalledModels: async () => [uiMate.id],
  getModelVisionStatus: async () => ({}),
  getActiveModelIds: async () => activeIds,
  estimateModelFit: async () => ({ level: 'ok' }),
  activateModel: async (id: string, requestedKind?: string) => {
    activationRequests.push([id, requestedKind])
    activeIds = [id]
    return { success: true }
  },
  downloadModel: async () => new Promise(() => {}),
  cancelModelDownload: async () => true,
  searchModels: async () => [],
  onModelProgress: () => () => {}
}

let ModelsScreen: typeof import('../ModelsScreen').ModelsScreen
beforeAll(async () => {
  ModelsScreen = (await import('../ModelsScreen')).ModelsScreen
})
afterEach(() => {
  activeIds = []
  activationRequests = []
  cleanup()
})

describe('<ModelsScreen/> Computer Use catalog journey', () => {
  it('renders the direct Computer Use route and sends every model tab through one route owner', async () => {
    const onNavigateSubroute = vi.fn()
    const user = userEvent.setup()
    render(
      <ModelsScreen navigationSubroute="computer-use" onNavigateSubroute={onNavigateSubroute} />
    )

    expect(
      (await screen.findByRole('button', { name: 'Computer Use' })).getAttribute('aria-current')
    ).toBe('page')
    for (const [label, subroute] of [
      ['Text', null],
      ['Image', 'image'],
      ['Computer Use', 'computer-use'],
      ['Voice', 'voice'],
      ['Transcription', 'transcription'],
      ['Storage', 'storage']
    ] as const) {
      await user.click(screen.getByRole('button', { name: new RegExp(`^${label}`) }))
      expect(onNavigateSubroute).toHaveBeenLastCalledWith(subroute)
    }
  })

  it('uses the shared tab, filters, cards, activation, and download states', async () => {
    const user = userEvent.setup()
    render(<ModelsScreen />)

    await user.click(await screen.findByRole('button', { name: 'Computer Use' }))

    const installed = await screen.findByRole('list', { name: 'Models on this device' })
    const available = screen.getByRole('list', { name: 'Models available to download' })
    expect(within(installed).getByText('UI-Mate-9B')).toBeTruthy()
    expect(within(available).getByText('UI-TARS-1.5-7B')).toBeTruthy()
    expect(within(available).getByText('UI-Mate-27B')).toBeTruthy()
    expect(within(available).getByText('Holo3.1-4B')).toBeTruthy()
    expect(screen.queryByRole('list', { name: 'Computer Use models coming soon' })).toBeNull()
    expect(screen.getByText(`${computerUseModels.length} models`)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'All sources' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Any size' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Sort: Recommended' })).toBeTruthy()

    await user.click(screen.getByRole('button', { name: 'Any size' }))
    await user.click(screen.getByRole('button', { name: '< 1B' }))
    expect(await screen.findByText('1 models')).toBeTruthy()
    expect(screen.getByText('Holo3.1-0.8B')).toBeTruthy()
    expect(screen.queryByText('UI-Mate-27B')).toBeNull()

    await user.click(screen.getByRole('button', { name: 'Clear' }))
    expect(await screen.findByText('UI-Mate-9B')).toBeTruthy()
    expect(screen.getByText('UI-TARS-1.5-7B')).toBeTruthy()
    expect(screen.getByText(`${computerUseModels.length} models`)).toBeTruthy()

    const holoCard = screen.getByText('Holo3.1-0.8B').closest('[role="listitem"]')
    expect(holoCard).toBeTruthy()
    expect(within(holoCard as HTMLElement).getByRole('button', { name: 'Download' })).toBeTruthy()

    await user.click(screen.getByRole('button', { name: 'Use' }))
    expect(await screen.findByText('Active')).toBeTruthy()
    expect(activationRequests.at(-1)).toEqual([uiMate.id, 'computer_use'])

    const uiTarsCard = screen.getByText('UI-TARS-1.5-7B').closest('[role="listitem"]')
    expect(uiTarsCard).toBeTruthy()
    await user.click(within(uiTarsCard as HTMLElement).getByRole('button', { name: 'Download' }))
    expect(await screen.findByText('Queued')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeTruthy()
  })
})
