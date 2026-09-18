// @vitest-environment jsdom

import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

const BONSAI = {
  id: 'prism-ml/Ternary-Bonsai-2-27B-gguf',
  name: 'Bonsai 2 27B',
  kind: 'text',
  org: 'Prism ML',
  params: 27,
  minRamGb: 16,
  files: [
    { name: 'Ternary-Bonsai-2-27B-PQ2_0.gguf', sizeBytes: 7_206_168_928 },
    { name: 'Ternary-Bonsai-2-27B-mmproj-Q8_0.gguf', sizeBytes: 629_246_976 }
  ]
}
const SMALL = {
  id: 'acme/small',
  name: 'Small Model',
  kind: 'text',
  org: 'Acme',
  params: 2,
  files: [{ name: 'small.gguf', sizeBytes: 2_000_000_000 }]
}

let ramGb = 16
let catalogModels: Array<typeof BONSAI | typeof SMALL | Record<string, unknown>> = [SMALL, BONSAI]
let installedIds: string[] = []
;(window as unknown as { api: unknown }).api = {
  systemHealth: async () => ({ ramGb }),
  getModelCatalog: async () => ({ kinds: ['text'], models: catalogModels }),
  getInstalledModels: async () => installedIds,
  getActiveModelIds: async () => [],
  getModelVisionStatus: async () => ({}),
  onModelProgress: () => () => {},
  searchModels: async () => []
}

describe('<ModelsScreen/> Bonsai recommendation', () => {
  afterEach(() => {
    cleanup()
    catalogModels = [SMALL, BONSAI]
    installedIds = []
  })

  it('shows Bonsai first with recommendation badges on a 16 GB machine', async () => {
    ramGb = 16
    const { ModelsScreen } = await import('../ModelsScreen')
    render(<ModelsScreen />)
    await screen.findByText(BONSAI.name)
    await waitFor(() =>
      expect(screen.getAllByRole('listitem')[0]?.textContent).toContain(BONSAI.name)
    )
    const card = screen.getByText(BONSAI.name).closest('[role="listitem"]') as HTMLElement
    expect(within(card).getByText('Works best')).toBeTruthy()
    expect(within(card).getByText('Recommended for you')).toBeTruthy()
  })

  it('keeps Bonsai available without recommendation badges on an 8 GB machine', async () => {
    ramGb = 8
    const { ModelsScreen } = await import('../ModelsScreen')
    render(<ModelsScreen />)
    await screen.findByText(BONSAI.name)
    const card = screen.getByText(BONSAI.name).closest('[role="listitem"]') as HTMLElement
    expect(within(card).queryByText('Works best')).toBeNull()
    expect(within(card).queryByText('Recommended for you')).toBeNull()
  })

  it('recognizes a downloaded Bonsai variant by its source model ID', async () => {
    ramGb = 34
    const packageId = 'model-package-v1:bonsai-variant'
    installedIds = [packageId]
    catalogModels = [
      {
        ...BONSAI,
        id: packageId,
        sourceModelId: BONSAI.id,
        tags: ['Downloaded'],
        files: [
          BONSAI.files[0],
          { name: 'Ternary-Bonsai-2-27B-mmproj-BF16.gguf', sizeBytes: 931_145_856 }
        ]
      }
    ]
    const { ModelsScreen } = await import('../ModelsScreen')
    render(<ModelsScreen />)
    const card = (await screen.findByText(BONSAI.name)).closest('[role="listitem"]') as HTMLElement
    await waitFor(() => expect(within(card).getByText('Works best')).toBeTruthy())
    expect(within(card).getByText('Recommended for you')).toBeTruthy()
  })
})
