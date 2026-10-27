// @vitest-environment jsdom

// Integration: the Text tab leads with Fast, Balanced and Best for this machine, chosen by the shared
// rule from the models that fit with room. Real ModelsScreen and real @offgrid/models; only
// window.api, the IPC line out of the renderer, is faked.
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'

const model = (id: string, name: string, params: number, gb: number): Record<string, unknown> => ({
  id,
  name,
  kind: 'text',
  org: 'Acme',
  params,
  description: `${name} for everyday chat`,
  files: [{ name: `${id}.gguf`, sizeBytes: gb * 1e9 }]
})
const image = (id: string, name: string, gb: number): Record<string, unknown> => ({
  id,
  name,
  kind: 'image',
  org: 'Acme',
  files: [{ name: `${id}.gguf`, sizeBytes: gb * 1e9 }]
})
const IMAGE_MODELS = [
  image('offgrid-ai/dreamshaper-xl-v2-turbo-GGUF', 'DreamShaper XL v2 Turbo', 4.2),
  image('offgrid-ai/realvisxl-v5.0-lightning-GGUF', 'RealVisXL v5.0 Lightning', 2.8),
  image('offgrid-ai/juggernaut-xl-v9-GGUF', 'Juggernaut XL v9', 4.3),
  image('offgrid-ai/Qwen-Image-2.1-Turbo-GGUF', 'Qwen-Image 2.1 Turbo', 14.5),
  image('offgrid-ai/Qwen-Image-2.1-GGUF', 'Qwen-Image 2.1', 14.5),
  image('leejet/flux-3-image-klein-GGUF', 'FLUX 3 Image Klein', 9),
  image('someone/other-image', 'Other Image', 3)
]
const MODELS = [
  model('acme/tiny', 'Tiny 0.8B', 0.8, 0.7),
  model('acme/two', 'Two 2B', 2, 1.9),
  model('acme/four', 'Four 4B', 4, 3.8),
  model('acme/nine', 'Nine 9B', 9, 5.9),
  model('acme/big', 'Big 27B', 27, 18)
]

let ramGb = 16
;(window as unknown as { api: unknown }).api = {
  systemHealth: async () => ({ ramGb }),
  getModelCatalog: async () => ({ kinds: ['text', 'image'], models: [...MODELS, ...IMAGE_MODELS] }),
  getInstalledModels: async () => [],
  getActiveModelIds: async () => [],
  getModelVisionStatus: async () => ({}),
  onModelProgress: () => () => {},
  searchModels: async () => []
}

const pickNames = (): string[] =>
  within(screen.getByRole('list', { name: /^Picks for this / }))
    .getAllByRole('listitem')
    .map((card) => card.textContent ?? '')

describe('<ModelsScreen/> picks for this device', () => {
  afterEach(() => cleanup())

  it('leads with Fast, Balanced and Best that fit with room, each shown once', async () => {
    ramGb = 16
    const { ModelsScreen } = await import('../ModelsScreen')
    render(<ModelsScreen />)

    await screen.findByRole('list', { name: /^Picks for this / })
    const [fast, balanced, best] = pickNames()
    expect(fast).toContain('Two 2B')
    expect(fast).toContain('Fast')
    expect(balanced).toContain('Four 4B')
    expect(balanced).toContain('Balanced')
    expect(best).toContain('Nine 9B')
    expect(best).toContain('Best')
    // The card says what the model is for.
    expect(best).toContain('Nine 9B for everyday chat')
    // A pick is not repeated in the list below.
    const available = screen.getByRole('list', { name: 'Models available to download' })
    expect(within(available).queryByText('Nine 9B')).toBeNull()
    expect(within(available).getByText('Tiny 0.8B')).toBeTruthy()
  })

  it('steps aside once a filter says what the person wants', async () => {
    ramGb = 16
    const user = userEvent.setup()
    const { ModelsScreen } = await import('../ModelsScreen')
    render(<ModelsScreen />)

    await screen.findByRole('list', { name: /^Picks for this / })
    await user.click(screen.getByRole('radio', { name: '≤4GB' }))
    expect(screen.queryByRole('list', { name: /^Picks for this / })).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Clear filters' }))
    expect(await screen.findByRole('list', { name: /^Picks for this / })).toBeTruthy()
  })

  it('shows no picks on a machine where nothing fits with room', async () => {
    ramGb = 1
    const { ModelsScreen } = await import('../ModelsScreen')
    render(<ModelsScreen />)

    await screen.findByText('Tiny 0.8B')
    expect(screen.queryByRole('list', { name: /^Picks for this / })).toBeNull()
  })

  it('leads the Image tab with DreamShaper, then Qwen-Image 2.1 Turbo and FLUX 3 Image Klein where they run', async () => {
    ramGb = 24
    const user = userEvent.setup()
    const { ModelsScreen } = await import('../ModelsScreen')
    render(<ModelsScreen />)

    await screen.findByRole('list', { name: /^Picks for this / })
    await user.click(screen.getByRole('radio', { name: 'Image' }))
    await screen.findByText('Qwen-Image 2.1 Turbo')
    const [fast, balanced, best] = pickNames()
    expect(fast).toContain('DreamShaper XL v2 Turbo')
    expect(balanced).toContain('Qwen-Image 2.1 Turbo')
    expect(best).toContain('FLUX 3 Image Klein')
    expect(pickNames().join(' ')).not.toContain('Other Image')
  })

  it('leads the Image tab with the SDXL line where Qwen-Image does not run', async () => {
    ramGb = 8
    const user = userEvent.setup()
    const { ModelsScreen } = await import('../ModelsScreen')
    render(<ModelsScreen />)

    await user.click(await screen.findByRole('radio', { name: 'Image' }))
    await screen.findByText('Juggernaut XL v9')
    const [fast, balanced, best] = pickNames()
    expect(fast).toContain('DreamShaper XL v2 Turbo')
    expect(balanced).toContain('RealVisXL v5.0 Lightning')
    expect(best).toContain('Juggernaut XL v9')
  })
})
