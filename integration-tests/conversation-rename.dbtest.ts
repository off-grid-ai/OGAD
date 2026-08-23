// @vitest-environment jsdom

/**
 * RELEASE_TEST_CHECKLIST #44 - the production chat surface renames scoped and
 * unscoped conversations through the real SQLite owner. Electron IPC and model
 * processes are the only controlled boundaries. Remounting the surface proves
 * the stored name survives navigation and is rendered in both sidebar and tab.
 */
import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-conversation-rename-'))

vi.mock('electron', () => ({
  app: { getPath: () => TMP_DIR, isPackaged: false, getAppPath: () => process.cwd() },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString()
  }
}))

const database = await import('@offgrid/core/main/database')
const skills = await import('@offgrid/core/main/skills')
const { MemoryChat } = await import('@renderer/components/MemoryChat')
const { TooltipProvider } = await import('@renderer/components/ui/tooltip')

function installApi(): void {
  Object.assign(window, {
    api: {
      getRagConversations: async () => database.getRagConversations(),
      getRagConversation: async (id: string) => database.getRagConversation(id),
      getRagMessages: async (id: string) => database.getRagMessages(id),
      updateRagConversationTitle: async (id: string, title: string) =>
        database.updateRagConversationTitle(id, title),
      getSettings: async () => database.getSettings(),
      saveSetting: async (key: string, value: unknown) => database.saveSetting(key, value),
      listSkills: async () => skills.listSkills(),
      imageGenStatus: async () => ({ available: false, models: [], active: '' }),
      onRagStream: () => () => undefined,
      onImageGenProgress: () => () => undefined
    }
  })
}

function renderChat(): void {
  render(React.createElement(TooltipProvider, null, React.createElement(MemoryChat)))
}

async function beginRename(user: ReturnType<typeof userEvent.setup>, title: string): Promise<void> {
  fireEvent.pointerDown(
    await screen.findByRole('button', { name: `Conversation actions for ${title}` }),
    { button: 0, ctrlKey: false }
  )
  await user.click(screen.getByRole('menuitem', { name: 'Rename' }))
}

beforeEach(() => {
  database.getDB().exec('DELETE FROM rag_messages; DELETE FROM rag_conversations;')
  installApi()
  ;(Element.prototype as unknown as { scrollIntoView(): void }).scrollIntoView = () => {}
  globalThis.requestAnimationFrame = (callback: FrameRequestCallback): number => {
    callback(0)
    return 1
  }
})

afterEach(() => cleanup())

afterAll(() => {
  database.getDB().close()
  fs.rmSync(TMP_DIR, { recursive: true, force: true })
})

describe('<MemoryChat/> conversation rename', () => {
  it.each([
    ['unscoped', null],
    ['project-scoped', 'project-alpha']
  ])(
    'persists a %s title in the sidebar and open tab after remount (#44)',
    async (_, projectId) => {
      database.createRagConversation('conversation-target', 'Before rename', projectId)
      const user = userEvent.setup()
      renderChat()

      await beginRename(user, 'Before rename')
      const input = screen.getByRole('textbox', {
        name: 'Rename conversation'
      }) as HTMLInputElement
      expect(input.value).toBe('Before rename')
      expect(document.activeElement).toBe(input)
      expect(input.selectionStart).toBe(0)
      expect(input.selectionEnd).toBe('Before rename'.length)

      await user.clear(input)
      await user.keyboard('{Enter}')
      expect((await screen.findByRole('alert')).textContent).toContain('Enter a conversation name.')
      expect(database.getRagConversation('conversation-target')?.title).toBe('Before rename')

      await user.type(input, '  After rename  ')
      await user.keyboard('{Enter}')
      await waitFor(() => expect(screen.getAllByText('After rename')).toHaveLength(2))
      expect(database.getRagConversation('conversation-target')?.title).toBe('After rename')

      cleanup()
      installApi()
      renderChat()
      await waitFor(() => expect(screen.getAllByText('After rename')).toHaveLength(2))
      expect(screen.queryByText('Before rename')).toBeNull()
    }
  )

  it('keeps the inline editor open with a retry message when persistence fails (#44)', async () => {
    database.createRagConversation('conversation-target', 'Stored name')
    const user = userEvent.setup()
    renderChat()
    await beginRename(user, 'Stored name')

    database.deleteRagConversation('conversation-target')
    const input = screen.getByRole('textbox', { name: 'Rename conversation' })
    await user.clear(input)
    await user.type(input, 'Cannot persist')
    await user.keyboard('{Enter}')

    expect((await screen.findByRole('alert')).textContent).toContain('Rename failed. Try again.')
    expect(
      (screen.getByRole('textbox', { name: 'Rename conversation' }) as HTMLInputElement).value
    ).toBe('Cannot persist')
  })

  it('cancels inline rename with Escape without writing (#44)', async () => {
    database.createRagConversation('conversation-target', 'Keep this name')
    const user = userEvent.setup()
    renderChat()
    await beginRename(user, 'Keep this name')

    const input = screen.getByRole('textbox', { name: 'Rename conversation' })
    await user.clear(input)
    await user.type(input, 'Discard this draft')
    await user.keyboard('{Escape}')

    expect(screen.queryByRole('textbox', { name: 'Rename conversation' })).toBeNull()
    expect(screen.getAllByText('Keep this name')).toHaveLength(2)
    expect(database.getRagConversation('conversation-target')?.title).toBe('Keep this name')
  })
})
