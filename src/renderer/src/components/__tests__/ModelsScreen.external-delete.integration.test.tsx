// @vitest-environment jsdom
// A model found in another app's folder (LM Studio, Ollama) can be removed: it moves to the Trash,
// and the screen says so before it asks. Main is faked at the IPC line; the in-app dialog is real.

import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ConfirmDialogHost } from '../ConfirmDialogHost'

const EXTERNAL_ID = 'external:lmstudio-qwen'
let installed = [EXTERNAL_ID]
const deleted: string[] = []
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

let ModelsScreen: () => React.JSX.Element
beforeAll(async () => {
  ModelsScreen = (await import('../ModelsScreen')).ModelsScreen
})
afterEach(() => {
  cleanup()
  installed = [EXTERNAL_ID]
  deleted.length = 0
  deleteResult = { success: true }
})

async function deleteExternal(user: ReturnType<typeof userEvent.setup>): Promise<HTMLElement> {
  render(
    <>
      <ModelsScreen />
      <ConfirmDialogHost />
    </>
  )
  const card = (await screen.findByText('Qwen Local')).closest('[role="listitem"]') as HTMLElement
  const remove = within(card).getByRole('button', { name: 'Delete' })
  expect(remove.getAttribute('title')).toBe('Move to the Trash')
  await user.click(remove)
  return card
}

describe('<ModelsScreen/> a model from another app', () => {
  it('moves to the Trash after saying so', async () => {
    const user = userEvent.setup()
    await deleteExternal(user)
    const dialog = await screen.findByRole('alertdialog')
    expect(within(dialog).getByText('Move "Qwen Local" to the Trash?')).toBeTruthy()
    expect(deleted).toEqual([])
    await user.click(within(dialog).getByRole('button', { name: 'Move to Trash' }))
    await waitFor(() => expect(deleted).toEqual([EXTERNAL_ID]))
    // Main no longer lists it as installed, so its card no longer offers a delete.
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Delete' })).toBeNull())
  })

  it('keeps the model when the person cancels', async () => {
    const user = userEvent.setup()
    await deleteExternal(user)
    const dialog = await screen.findByRole('alertdialog')
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
    expect(deleted).toEqual([])
  })

  it('says why when the move is refused', async () => {
    deleteResult = { success: false, error: 'The Trash is not available for this folder.' }
    const user = userEvent.setup()
    await deleteExternal(user)
    await user.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Move to Trash' })
    )
    const notice = await screen.findByText('The Trash is not available for this folder.')
    const dialog = notice.closest('[role="alertdialog"]') as HTMLElement
    expect(within(dialog).getByText('Couldn\'t remove "Qwen Local"')).toBeTruthy()
    await user.click(within(dialog).getByRole('button', { name: 'OK' }))
  })
})
