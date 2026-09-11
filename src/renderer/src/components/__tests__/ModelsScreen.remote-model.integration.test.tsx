// @vitest-environment jsdom

import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { modelControlBoundary } from './harness/model-control-snapshot'
import { ModelsScreen } from '../ModelsScreen'

const REMOTE_ID = 'remote-vision:home:google%2Fgemma-4'

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

const modelControl = modelControlBoundary({
  kinds: ['text', 'vision'],
  models: [REMOTE_MODEL],
  installed: [REMOTE_ID]
})

;(globalThis as unknown as { window: { api: unknown } }).window.api = {
  systemHealth: async () => ({ ramGb: 32 }),
  ...modelControl,
  getModelCatalog: async () => ({
    kinds: ['text', 'vision'],
    models: [REMOTE_MODEL]
  }),
  getInstalledModels: async () => [REMOTE_ID],
  getModelVisionStatus: async () => ({}),
  getActiveModelIds: async () => modelControl.projection().activeIds,
  estimateModelFit: async () => ({ level: 'ok' }),
  searchModels: async () => [],
  onModelProgress: () => () => {}
}

afterEach(() => {
  modelControl.reset()
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
    // The card reads Active because the boundary really activated this route, not because the
    // screen was told a call happened.
    expect(await within(card as HTMLElement).findByText('Active')).toBeTruthy()
    expect(modelControl.projection().active.text.modelId).toBe(REMOTE_ID)
  })
})
