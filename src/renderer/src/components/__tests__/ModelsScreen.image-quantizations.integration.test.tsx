// @vitest-environment jsdom

// Integration: an image model with several quantizations is ONE card on the Models screen, and the
// quantization is chosen in its side panel, the way text models choose a file. Real ModelsScreen
// over the real shared catalog rules (collapseQuantizations); only window.api, the IPC line out of
// the renderer, is faked, and it answers the way main does (catalog, installed ids, downloads).
//
// Also: Hugging Face search on the Image tab. A repo found there is downloaded through the file
// picker and, once main reports it installed as an image model, shows on the Image tab as on this
// device.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

const FULL = {
  id: 'offgrid-ai/realvisxl-v5.0-GGUF',
  name: 'RealVisXL v5.0 (photoreal)',
  kind: 'image',
  org: 'RealVis',
  quant: 'Q8_0',
  quantLabel: 'Full quality',
  tags: ['High quality', 'Photoreal'],
  files: [{ name: 'realvisxl-v5.0-Q8_0.gguf', role: 'primary', sizeBytes: 4.18e9, url: 'x' }]
}
const LIGHT = {
  id: 'offgrid-ai/realvisxl-v5.0-GGUF-Q4',
  name: 'RealVisXL v5.0 (Light)',
  kind: 'image',
  org: 'RealVis',
  quant: 'Q4_K',
  quantOf: FULL.id,
  quantLabel: 'Light',
  tags: ['Photoreal', 'Light'],
  files: [{ name: 'realvisxl-v5.0-Q4_K.gguf', role: 'primary', sizeBytes: 2.8e9, url: 'x' }]
}
const SDXL_TURBO = {
  id: 'stabilityai/sdxl-turbo',
  name: 'SDXL Turbo (fast drafts)',
  kind: 'image',
  org: 'Stability AI',
  files: [{ name: 'sd_xl_turbo_1.0.q8_0.gguf', role: 'primary', sizeBytes: 4.1e9, url: 'x' }]
}
const HF_REPO = 'someone/Chroma-GGUF'

let catalog: Record<string, unknown>[] = []
let installed: string[] = []
let active: string[] = []
const downloads: { id: string; fileName?: string }[] = []
let inventoryChanged: () => void = () => {}

beforeEach(() => {
  catalog = [FULL, LIGHT, SDXL_TURBO]
  installed = []
  active = []
  downloads.length = 0
  ;(window as unknown as { api: unknown }).api = {
    systemHealth: async () => ({ ramGb: 32 }),
    getModelCatalog: async () => ({ kinds: ['image'], models: catalog }),
    getInstalledModels: async () => installed,
    getActiveModelIds: async () => active,
    getModelVisionStatus: async () => ({}),
    estimateModelFit: async () => ({ level: 'ok' }),
    onModelProgress: () => () => {},
    onModelInventoryChanged: (cb: () => void) => {
      inventoryChanged = cb
      return () => {}
    },
    searchModels: async (query: string, kind: string) =>
      kind === 'image' && /chroma/i.test(query)
        ? [{ id: HF_REPO, name: 'Chroma-GGUF', org: 'someone' }]
        : [],
    getModelFiles: async (id: string) =>
      id === HF_REPO
        ? [{ fileName: 'chroma-unlocked-v50-Q4_K_M.gguf', quant: 'Q4_K_M', sizeBytes: 5.2e9 }]
        : [],
    downloadModel: async (id: string, fileName?: string) => {
      downloads.push({ id, fileName })
      return { success: true }
    }
  }
})

afterEach(() => cleanup())

const cardNames = (): string[] =>
  screen
    .getAllByRole('button')
    .map((button) => button.textContent ?? '')
    .filter((text) => /RealVisXL|SDXL Turbo|Chroma/.test(text))

describe('<ModelsScreen/> image quantizations', () => {
  it('shows one card per image model and downloads the quantization chosen in its side panel', async () => {
    const { ModelsScreen } = await import('../ModelsScreen')
    const user = userEvent.setup()
    render(<ModelsScreen />)

    await screen.findByText('RealVisXL v5.0 (photoreal)')
    expect(cardNames().filter((name) => name.includes('RealVisXL'))).toEqual([
      'RealVisXL v5.0 (photoreal)'
    ])
    expect(screen.queryByText('RealVisXL v5.0 (Light)')).toBeNull()

    // Download on the card opens the side panel to choose the size; nothing downloads yet.
    const downloadButtons = screen.getAllByRole('button', { name: 'Download' })
    await user.click(downloadButtons[0]!)
    const panel = await screen.findByRole('dialog', { name: /RealVisXL v5.0/ })
    expect(downloads).toEqual([])

    const choice = within(panel).getByRole('radiogroup', { name: 'Quantization' })
    expect(within(choice).getByRole('radio', { name: /Full quality/ }).getAttribute('aria-checked')).toBe('true')
    await user.click(within(choice).getByRole('radio', { name: /Light/ }))
    expect(within(choice).getByRole('radio', { name: /Light/ }).getAttribute('aria-checked')).toBe('true')
    await user.click(within(screen.getByRole('dialog', { name: /RealVisXL v5.0/ })).getByRole('button', { name: /Download/ }))
    await waitFor(() => expect(downloads).toEqual([{ id: LIGHT.id, fileName: undefined }]))
  })

  it('shows an installed Light quantization under the one card, on this device', async () => {
    installed = [LIGHT.id]
    active = [LIGHT.id]
    const { ModelsScreen } = await import('../ModelsScreen')
    const user = userEvent.setup()
    render(<ModelsScreen />)

    const onDevice = await screen.findByRole('list', { name: /on this device/i })
    expect(within(onDevice).getByText('RealVisXL v5.0 (photoreal)')).toBeTruthy()
    expect(screen.queryByText('RealVisXL v5.0 (Light)')).toBeNull()
    // The Full quality option is not offered as a second card.
    expect(cardNames().filter((name) => name.includes('RealVisXL'))).toHaveLength(1)

    await user.click(within(onDevice).getByText('RealVisXL v5.0 (photoreal)'))
    const panel = await screen.findByRole('dialog', { name: /RealVisXL v5.0/ })
    const light = within(panel).getByRole('radio', { name: /Light/ })
    expect(light.getAttribute('aria-checked')).toBe('true')
    expect(light.textContent).toContain('Active')
    expect(within(panel).getByRole('radio', { name: /Full quality/ }).textContent).not.toContain(
      'Installed'
    )
  })

  it('finds an image model on Hugging Face from the Image tab, downloads it, and lists it as on this device', async () => {
    const { ModelsScreen } = await import('../ModelsScreen')
    const user = userEvent.setup()
    render(<ModelsScreen />)
    await screen.findByText('SDXL Turbo (fast drafts)')

    await user.type(screen.getByPlaceholderText('Search HuggingFace…'), 'chroma')
    const result = await screen.findByText('Chroma-GGUF')
    const row = result.closest('[role="listitem"]') ?? result.parentElement!
    await user.click(within(row as HTMLElement).getByRole('button', { name: 'Download' }))
    const picker = await screen.findByRole('dialog', { name: /Choose a file/ })
    await user.click(within(picker).getByRole('button', { name: /chroma-unlocked-v50-Q4_K_M\.gguf/ }))
    await waitFor(() =>
      expect(downloads).toEqual([{ id: HF_REPO, fileName: 'chroma-unlocked-v50-Q4_K_M.gguf' }])
    )

    // Main records the repo as an image model (Hugging Face labels it text-to-image) and says so.
    catalog = [
      ...catalog,
      {
        id: HF_REPO,
        name: 'Chroma-GGUF',
        kind: 'image',
        org: 'someone',
        files: [{ name: 'chroma-unlocked-v50-Q4_K_M.gguf', role: 'primary', sizeBytes: 5.2e9, url: 'x' }]
      }
    ]
    installed = [HF_REPO]
    await user.clear(screen.getByPlaceholderText('Search HuggingFace…'))
    inventoryChanged()

    const onDevice = await screen.findByRole('list', { name: /on this device/i })
    await waitFor(() => expect(within(onDevice).getByText('Chroma-GGUF')).toBeTruthy())
  })
})
