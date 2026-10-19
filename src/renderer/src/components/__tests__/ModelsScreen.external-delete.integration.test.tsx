// @vitest-environment jsdom
// A model found in another app's folder (LM Studio, Ollama) can be removed: it moves to the Trash,
// and the screen says so before it asks. Main is faked at the IPC line, and the browser's
// confirm/alert dialogs are the only other boundary.

import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

const EXTERNAL_ID = 'external:lmstudio-qwen'
let installed = [EXTERNAL_ID]
const deleted: string[] = []
const asked: string[] = []
const alerted: string[] = []
let deleteResult: { success: boolean; error?: string } = { success: true }

;(globalThis as unknown as { window: { api: unknown } }).window.api = {
  systemHealth: async () => ({ ramGb: 32 }),
  getModelCatalog: async () => ({
    kinds: ['text'],
    models: [
      {
        id: EXTERNAL_ID,
        name: 'Qwen Local',
        kind: 'text',
        org: 'LM Studio',
        files: [{ name: '/Users/me/.lmstudio/models/qwen.gguf', role: 'primary' }],
        tags: []
      }
    ]
  }),
  getInstalledModels: async () => installed,
  getModelVisionStatus: async () => ({}),
  getActiveModelIds: async () => [],
  estimateModelFit: async () => ({ level: 'ok' }),
  deleteModel: async (id: string) => {
    deleted.push(id)
    if (deleteResult.success) installed = []
    return deleteResult
  },
  searchModels: async () => [],
  onModelProgress: () => () => {}
}
window.confirm = (message?: string): boolean => {
  asked.push(String(message))
  return true
}
window.alert = (message?: string): void => {
  alerted.push(String(message))
}

let ModelsScreen: () => React.JSX.Element
beforeAll(async () => {
  ModelsScreen = (await import('../ModelsScreen')).ModelsScreen
})
afterEach(() => {
  cleanup()
  installed = [EXTERNAL_ID]
  deleted.length = 0
  asked.length = 0
  alerted.length = 0
  deleteResult = { success: true }
})

async function deleteExternal(): Promise<HTMLElement> {
  const user = userEvent.setup()
  render(<ModelsScreen />)
  const card = (await screen.findByText('Qwen Local')).closest('[role="listitem"]') as HTMLElement
  const remove = within(card).getByRole('button', { name: 'Delete' })
  expect(remove.getAttribute('title')).toBe('Move to the Trash')
  await user.click(remove)
  return card
}

describe('<ModelsScreen/> a model from another app', () => {
  it('moves to the Trash after saying so', async () => {
    await deleteExternal()
    await waitFor(() => expect(deleted).toEqual([EXTERNAL_ID]))
    expect(asked).toHaveLength(1)
    expect(asked[0]).toContain('Move "Qwen Local" to the Trash?')
    // Main no longer lists it as installed, so its card no longer offers a delete.
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Delete' })).toBeNull())
  })

  it('says why when the move is refused', async () => {
    deleteResult = { success: false, error: 'The Trash is not available for this folder.' }
    await deleteExternal()
    await waitFor(() => expect(alerted).toEqual(['The Trash is not available for this folder.']))
  })
})
