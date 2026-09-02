// @vitest-environment jsdom

import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { modelControlSnapshot } from './harness/model-control-snapshot'

const REMOTE_ID = 'remote-vision:home:google%2Fgemma-4'
let activeIds: string[] = []
const activateModel = vi.fn(async (id: string) => {
  activeIds = [id]
  return { success: true }
})

const REMOTE_MODEL = {
  id: REMOTE_ID,
  name: 'google/gemma-4',
  kind: 'vision',
  org: 'Home server',
  files: [],
  tags: ['Remote'],
  remoteServerId: 'home',
  remoteModelId: 'google/gemma-4'
}

;(globalThis as unknown as { window: { api: unknown } }).window.api = {
  systemHealth: async () => ({ ramGb: 32 }),
  getModelControlSnapshot: async () =>
    modelControlSnapshot({
      kinds: ['text', 'vision'],
      models: [REMOTE_MODEL],
      installed: [REMOTE_ID],
      activeIds,
      active: { text: activeIds[0] ?? null }
    }),
  getModelCatalog: async () => ({
    kinds: ['text', 'vision'],
    models: [REMOTE_MODEL]
  }),
  getInstalledModels: async () => [REMOTE_ID],
  getModelVisionStatus: async () => ({}),
  getActiveModelIds: async () => activeIds,
  estimateModelFit: async () => ({ level: 'ok' }),
  activateModel,
  searchModels: async () => [],
  onModelProgress: () => () => {}
}

let ModelsScreen: () => React.JSX.Element
beforeAll(async () => {
  ModelsScreen = (await import('../ModelsScreen')).ModelsScreen
})
afterEach(() => {
  activeIds = []
  activateModel.mockClear()
  cleanup()
})

describe('<ModelsScreen/> remote inventory', () => {
  it('shows a saved remote model, activates it, and never offers a disk delete', async () => {
    const user = userEvent.setup()
    render(<ModelsScreen />)

    const installed = await screen.findByRole('list', { name: 'Models on this device' })
    const card = within(installed).getByText('google/gemma-4').closest('[role="listitem"]')
    expect(card).toBeTruthy()
    expect(within(card as HTMLElement).getByText('Remote')).toBeTruthy()
    expect(within(card as HTMLElement).queryByTitle('Delete from disk')).toBeNull()

    await user.click(within(card as HTMLElement).getByRole('button', { name: 'Use' }))
    await waitFor(() => expect(activateModel).toHaveBeenCalledWith(REMOTE_ID, undefined))
    expect(await within(card as HTMLElement).findByText('Active')).toBeTruthy()
  })
})
