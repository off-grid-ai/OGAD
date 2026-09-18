// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

const repo = 'prism-ml/Ternary-Bonsai-2-27B-gguf'
const downloadModel = vi.fn(async () => ({ success: true }))
;(window as unknown as { api: unknown }).api = {
  systemHealth: async () => ({ ramGb: 32 }),
  getModelCatalog: async () => ({ kinds: ['text'], models: [] }),
  getInstalledModels: async () => [],
  getActiveModelIds: async () => [],
  getModelVisionStatus: async () => ({}),
  onModelProgress: () => () => {},
  searchModels: async () => [{ id: repo, name: 'Ternary-Bonsai-2-27B-gguf', org: 'prism-ml' }],
  getModelFiles: async () => [
    { fileName: 'Ternary-Bonsai-2-27B-F16.gguf', quant: 'F16', sizeBytes: 53_800_000_000 },
    { fileName: 'Ternary-Bonsai-2-27B-PTQ1_0.gguf', quant: 'PTQ1_0', sizeBytes: 5_950_000_000 }
  ],
  downloadModel
}

describe('<ModelsScreen/> Hugging Face variant download', () => {
  afterEach(() => { cleanup(); downloadModel.mockClear() })

  it('lets the user choose the 1-bit GGUF before downloading', async () => {
    const { ModelsScreen } = await import('../ModelsScreen')
    const user = userEvent.setup()
    render(<ModelsScreen />)
    await user.type(screen.getByPlaceholderText('Search HuggingFace…'), 'Bonsai')
    const model = await screen.findByRole('listitem')
    await user.click(within(model).getByRole('button', { name: 'Download' }))
    const picker = await screen.findByRole('dialog', { name: /Choose a file/ })
    expect(picker.closest('[data-testid="side-panel-layer"]')).toBeTruthy()
    expect(within(picker).getByText('Ternary-Bonsai-2-27B-F16.gguf')).toBeTruthy()
    await user.click(within(picker).getByRole('button', { name: /Ternary-Bonsai-2-27B-PTQ1_0.gguf/ }))
    expect(downloadModel).toHaveBeenCalledWith(repo, 'Ternary-Bonsai-2-27B-PTQ1_0.gguf')
  })
})
