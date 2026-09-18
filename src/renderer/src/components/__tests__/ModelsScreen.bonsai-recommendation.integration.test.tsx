// @vitest-environment jsdom

import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

const BONSAI = {
  id: 'prism-ml/Ternary-Bonsai-2-27B-gguf',
  name: 'Bonsai 2 27B (1-bit)',
  kind: 'text',
  org: 'Prism ML',
  params: 27,
  minRamGb: 16,
  files: [{ name: 'Ternary-Bonsai-2-27B-PTQ1_0.gguf', sizeBytes: 5_946_648_928 },
    { name: 'Ternary-Bonsai-2-27B-mmproj-Q8_0.gguf', sizeBytes: 629_246_976 }]
}
const SMALL = {
  id: 'acme/small', name: 'Small Model', kind: 'text', org: 'Acme', params: 2,
  files: [{ name: 'small.gguf', sizeBytes: 2_000_000_000 }]
}

let ramGb = 16
;(window as unknown as { api: unknown }).api = {
  systemHealth: async () => ({ ramGb }),
  getModelCatalog: async () => ({ kinds: ['text'], models: [SMALL, BONSAI] }),
  getInstalledModels: async () => [],
  getActiveModelIds: async () => [],
  getModelVisionStatus: async () => ({}),
  onModelProgress: () => () => {},
  searchModels: async () => []
}

describe('<ModelsScreen/> Bonsai recommendation', () => {
  afterEach(() => cleanup())

  it('shows Bonsai first with recommendation badges on a 16 GB machine', async () => {
    ramGb = 16
    const { ModelsScreen } = await import('../ModelsScreen')
    render(<ModelsScreen />)
    await screen.findByText(BONSAI.name)
    await waitFor(() => expect(screen.getAllByRole('listitem')[0]?.textContent).toContain(BONSAI.name))
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
})
