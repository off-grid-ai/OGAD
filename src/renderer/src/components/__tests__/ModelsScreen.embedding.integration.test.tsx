// @vitest-environment jsdom
import { afterEach, beforeAll, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

const searchModels = vi.fn(async (_query: string, _kind?: string) => [
  {
    id: 'onnx-community/example-embedding-ONNX',
    name: 'example-embedding-ONNX',
    org: 'onnx-community'
  }
])
const chooseEmbeddingModel = vi.fn(async () => ({ success: true }))

;(window as unknown as { api: unknown }).api = {
  systemHealth: async () => ({ ramGb: 16 }),
  getModelCatalog: async () => ({ kinds: ['text', 'embedding'], models: [] }),
  getInstalledModels: async () => [],
  getActiveModelIds: async () => [],
  getModelVisionStatus: async () => ({}),
  getEmbeddingModelChoices: async () => ({
    active: 'Xenova/all-MiniLM-L6-v2',
    models: [{ id: 'Xenova/all-MiniLM-L6-v2', name: 'MiniLM L6', detail: '384 dimensions' }]
  }),
  onModelProgress: () => () => {},
  searchModels,
  chooseEmbeddingModel
}

let ModelsScreen: typeof import('../ModelsScreen').ModelsScreen
beforeAll(async () => {
  ModelsScreen = (await import('../ModelsScreen')).ModelsScreen
})
afterEach(() => {
  cleanup()
  searchModels.mockClear()
  chooseEmbeddingModel.mockClear()
})

it('searches embedding repositories and lets a person use a result', async () => {
  const user = userEvent.setup()
  render(<ModelsScreen navigationSubroute="embedding" />)
  const search = await screen.findByRole('searchbox', { name: 'Search embedding models' })
  await user.type(search, 'example')
  await waitFor(() => expect(searchModels).toHaveBeenCalledWith('example', 'embedding'))
  const results = await screen.findByRole('list', { name: 'Embedding model search results' })
  const card = within(results)
    .getByText('example-embedding-ONNX')
    .closest('[role="listitem"]') as HTMLElement
  await user.click(within(card).getByRole('button', { name: 'Use' }))
  await waitFor(() =>
    expect(chooseEmbeddingModel).toHaveBeenCalledWith('onnx-community/example-embedding-ONNX')
  )
  expect(within(card).getByText('Active')).toBeTruthy()
})
