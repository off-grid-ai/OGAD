// @vitest-environment jsdom

// Computer Use enters through the real Models screen and uses the same catalog projection, filters,
// installed/available sections, card actions, and progress state as every other model kind. Only the
// Electron IPC bridge is controlled because it is outside the renderer process.
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { CATALOG, MODEL_KINDS, modelsByKind } from '@offgrid/models'
import { withTaskRoles } from './harness/task-roles'
import { wholeText } from './harness/whole-text'

const computerUseModels = modelsByKind('computer_use')
const uiMate = computerUseModels.find((model) => model.id === 'bartowski/tencent_UI-Mate-9B-GGUF')
const uiTars = computerUseModels.find((model) => model.id === 'mradermacher/UI-TARS-1.5-7B-GGUF')
if (!uiMate || !uiTars) throw new Error('Computer Use catalog fixtures are missing')

let activeIds: string[] = []
let activationRequests: Array<[string, string?]> = []

;(globalThis as unknown as { window: { api: unknown } }).window.api = {
  systemHealth: async () => ({ ramGb: 34 }),
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
  getModelScanFolders: async () => [],
  onModelProgress: () => () => {},
  // Main's task projections: the Tasks tab draws them as lineups, and cards name their roles.
  getComputerUseActiveModels: async () => ({
    strategy: 'decision_plus_specialist',
    strategyLabel: 'Decision + Reasoning + Specialist',
    models: [
      { role: 'decision', modelId: 'jaredpalmer/kev-4b', modelName: 'Kev 4B', remote: false },
      { role: 'reasoner', modelId: 'remote/chat', modelName: 'Remote Chat Model', remote: true },
      { role: 'grounding_specialist', modelId: uiMate.id, modelName: 'UI-Mate-9B', remote: false }
    ]
  }),
  getWebUseActiveModels: async () => ({
    strategy: 'separate_specialist',
    strategyLabel: 'Specialist',
    models: [
      { role: 'grounding_specialist', modelId: uiMate.id, modelName: 'UI-Mate-9B', remote: false }
    ]
  })
}
withTaskRoles((globalThis as unknown as { window: { api: Record<string, unknown> } }).window.api)

let ModelsScreen: typeof import('../ModelsScreen').ModelsScreen
beforeAll(async () => {
  ModelsScreen = (await import('../ModelsScreen')).ModelsScreen
}, 30_000)
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

    expect((await screen.findByRole('radio', { name: 'Tasks' })).getAttribute('aria-checked')).toBe(
      'true'
    )
    for (const [label, subroute] of [
      ['Text', null],
      ['Image', 'image'],
      ['Tasks', 'computer-use'],
      ['Voice', 'voice'],
      ['Transcription', 'transcription'],
      ['Storage', 'storage']
    ] as const) {
      await user.click(screen.getByRole('radio', { name: new RegExp(`^${label}`) }))
      expect(onNavigateSubroute).toHaveBeenLastCalledWith(subroute)
    }
  })

  it('uses the shared tab, filters, cards, activation, and download states', async () => {
    const user = userEvent.setup()
    render(<ModelsScreen />)

    await user.click(await screen.findByRole('radio', { name: 'Tasks' }))

    const installed = await screen.findByRole('list', {
      name: 'Grounding specialists on this device'
    })
    const available = screen.getByRole('list', {
      name: 'Grounding specialists available to download'
    })
    expect(within(installed).getByText('UI-Mate-9B')).toBeTruthy()
    expect(within(available).getByText('UI-TARS-1.5-7B')).toBeTruthy()
    expect(within(available).getByText('GUI-Owl-1.5-8B-Instruct')).toBeTruthy()
    expect(within(available).getByText('UI-Mate-27B')).toBeTruthy()
    expect(within(available).getByText('Holo3.1-4B')).toBeTruthy()
    expect(screen.queryByRole('list', { name: 'Grounding specialists coming soon' })).toBeNull()
    expect(await screen.findByText(wholeText(`${computerUseModels.length} models`))).toBeTruthy()
    expect(screen.getByRole('combobox', { name: 'All sources' })).toBeTruthy()
    expect(screen.getByRole('combobox', { name: 'Sort' }).textContent).toContain(
      'Sort: Recommended'
    )

    // One size filter: by download size.
    await user.click(screen.getByRole('radio', { name: '≤2GB' }))
    await waitFor(() => expect(screen.queryByText('UI-Mate-27B')).toBeNull())
    expect(screen.getByText('Holo3.1-0.8B')).toBeTruthy()

    await user.click(screen.getByRole('button', { name: 'Clear filters' }))
    // The card, not the lineup above the cards, which names it too.
    const onDevice = await screen.findByRole('list', {
      name: 'Grounding specialists on this device'
    })
    expect(within(onDevice).getByText('UI-Mate-9B')).toBeTruthy()
    expect(screen.getByText('UI-TARS-1.5-7B')).toBeTruthy()
    expect(await screen.findByText(wholeText(`${computerUseModels.length} models`))).toBeTruthy()

    const holoCard = screen.getByText('Holo3.1-0.8B').closest('[role="listitem"]')
    expect(holoCard).toBeTruthy()
    expect(within(holoCard as HTMLElement).getByRole('button', { name: 'Download' })).toBeTruthy()

    await user.click(screen.getByRole('button', { name: 'Use' }))
    // A task model names the role it now plays, not just "Active".
    expect(await screen.findByText(/Grounding specialist · Web Use and Computer Use/)).toBeTruthy()
    expect(activationRequests.at(-1)).toEqual([uiMate.id, 'computer_use'])

    const uiTarsCard = screen.getByText('UI-TARS-1.5-7B').closest('[role="listitem"]')
    expect(uiTarsCard).toBeTruthy()
    await user.click(within(uiTarsCard as HTMLElement).getByRole('button', { name: 'Download' }))
    expect(await screen.findByText('Queued')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeTruthy()
  })

  it('places text models and the GUI specialist in their product tabs, and offers no replaced model', async () => {
    const user = userEvent.setup()
    render(<ModelsScreen />)

    // The October audit marked the Qwen 3.8 distills replaced: no longer offered.
    expect(await screen.findByText('Qwen 3.5 4B')).toBeTruthy()
    expect(screen.queryByText('Qwen 3.8 4B Distill')).toBeNull()
    expect(screen.queryByText('GUI-Owl-1.5-8B-Instruct')).toBeNull()

    await user.click(screen.getByRole('radio', { name: 'Tasks' }))

    expect(await screen.findByText('GUI-Owl-1.5-8B-Instruct')).toBeTruthy()
    expect(screen.queryByText('Qwen 3.5 4B')).toBeNull()
  })

  it('lists grounding specialists and decision models apart, each card saying its role', async () => {
    activeIds = [uiMate.id]
    // The desktop adds its decision models to the shared catalog; one stands in for them here.
    const bridge = (globalThis as unknown as { window: { api: Record<string, unknown> } }).window
      .api
    const catalog = bridge.getModelCatalog
    bridge.getModelCatalog = async () => ({
      kinds: MODEL_KINDS,
      models: [
        ...CATALOG,
        {
          id: 'synthetic/decider-2b',
          name: 'Decider 2B',
          kind: 'computer_use',
          tags: ['Decision'],
          files: [{ name: 'decider.gguf', role: 'primary', size: 1 }]
        }
      ]
    })
    const user = userEvent.setup()
    render(<ModelsScreen />)
    await user.click(await screen.findByRole('radio', { name: 'Tasks' }))

    const grounding = await screen.findByRole('region', { name: 'Grounding specialists' })
    const decision = screen.getByRole('region', { name: 'Decision models' })
    expect(within(grounding).queryByText('Decider 2B')).toBeNull()
    expect(within(decision).getByText('Decider 2B')).toBeTruthy()
    expect(within(decision).queryByText('UI-Mate-9B')).toBeNull()
    // No lineup block here: the Tasks tab is cards, as the Text tab is.
    expect(screen.queryByText('Working together now')).toBeNull()
    // One model, two tasks: its card says so.
    const installed = within(grounding).getByRole('list', {
      name: 'Grounding specialists on this device'
    })
    expect(
      within(installed).getByText(/Grounding specialist · Web Use and Computer Use/)
    ).toBeTruthy()
    bridge.getModelCatalog = catalog
  })
})
