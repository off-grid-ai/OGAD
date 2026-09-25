// @vitest-environment jsdom

import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

const kev = {
  id: 'jaredpalmer/kev-4b',
  name: 'Kev 4B',
  kind: 'computer_use',
  org: 'Jared Palmer',
  description: 'Local pointer-head model for typed Computer Use decisions.',
  params: 4,
  minRamGb: 16,
  tags: ['Decision'],
  files: [
    {
      name: 'kev-4b/checkpoint/head.pt',
      url: 'https://example.test/head.pt',
      sizeBytes: 5_248_767,
      role: 'primary'
    },
    {
      name: 'kev-4b/base/model.safetensors-00001-of-00002.safetensors',
      url: 'https://example.test/1',
      sizeBytes: 5_329_398_712,
      role: 'aux'
    },
    {
      name: 'kev-4b/base/model.safetensors-00002-of-00002.safetensors',
      url: 'https://example.test/2',
      sizeBytes: 3_990_429_344,
      role: 'aux'
    }
  ]
}

;(window as unknown as { api: unknown }).api = {
  systemHealth: async () => ({ ramGb: 32 }),
  getModelCatalog: async () => ({ kinds: ['computer_use'], models: [kev] }),
  getInstalledModels: async () => [],
  getActiveModelIds: async () => [],
  getModelVisionStatus: async () => ({}),
  onModelProgress: () => () => {},
  searchModels: async () => [],
  downloadModel: async () => ({ success: true })
}

describe('<ModelsScreen/> Kev details', () => {
  afterEach(cleanup)

  it('explains why the existing GGUF chat model cannot replace the SafeTensors base', async () => {
    const { ModelsScreen } = await import('../ModelsScreen')
    const user = userEvent.setup()
    render(<ModelsScreen />)

    const card = (await screen.findByText('Kev 4B')).closest('[role="listitem"]') as HTMLElement
    await user.click(within(card).getByRole('button', { name: 'Details' }))

    const details = await screen.findByRole('dialog', { name: 'Kev 4B details' })
    const format = within(details).getByRole('region', { name: 'Kev model format' })
    expect(within(format).getByText(/GGUF contains quantized weights for llama.cpp/)).toBeTruthy()
    expect(within(format).getByText(/9.34 GB across two SafeTensors files/)).toBeTruthy()
    expect(within(details).queryByRole('region', { name: 'Available model files' })).toBeNull()
  })
})
