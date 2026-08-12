// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { MemoryChat } from '../MemoryChat'
import { TooltipProvider } from '../ui/tooltip'

const conversation = {
  id: 'conversation-copy',
  title: 'Clipboard regression',
  project_id: null,
  created_at: '2026-07-17T00:00:00.000Z',
  updated_at: '2026-07-17T00:00:00.000Z',
  message_count: 3
}

function installApi(): {
  bridgeWrite: ReturnType<typeof vi.fn>
  browserWrite: ReturnType<typeof vi.fn>
} {
  const bridgeWrite = vi.fn(async () => false)
  const browserWrite = vi.fn(async () => undefined)
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: browserWrite }
  })

  const api = {
    isPro: false,
    imageGenStatus: vi.fn(async () => ({ available: false, models: [], active: '' })),
    onImageGenProgress: vi.fn(() => () => {}),
    onRagStream: vi.fn(() => () => {}),
    getRagConversations: vi.fn(async () => [conversation]),
    getRagConversation: vi.fn(async () => conversation),
    // created_at is not decoration: the renderer projects every row through projectSyncedMessageTurn,
    // which refuses a message it cannot order and returns null, so an untimestamped row renders as
    // nothing at all. The table these rows stand for defaults it to SQLite's CURRENT_TIMESTAMP, in this
    // shape - naive UTC, space-separated.
    getRagMessages: vi.fn(async () => [
      { id: 1, role: 'user', content: 'copy this exact text', created_at: '2026-01-01 09:00:00' },
      {
        id: 2,
        role: 'assistant',
        content: 'assistant reply copied exactly',
        created_at: '2026-01-01 09:00:01'
      },
      {
        id: 3,
        role: 'assistant',
        content: 'generated image',
        context: JSON.stringify({ image: '/tmp/generated.png' }),
        created_at: '2026-01-01 09:00:02'
      }
    ]),
    getSettings: vi.fn(async () => ({})),
    saveSetting: vi.fn(async () => {}),
    listProjects: vi.fn(async () => []),
    styleThumbs: vi.fn(async () => ({})),
    listSkills: vi.fn(async () => []),
    writeClipboardText: bridgeWrite
  }
  ;(globalThis as unknown as { window: { api: unknown } }).window.api = api
  return { bridgeWrite, browserWrite }
}

function renderConversation(): void {
  render(
    <TooltipProvider>
      <MemoryChat openTarget={{ conversationId: conversation.id }} />
    </TooltipProvider>
  )
}

describe('<MemoryChat/> clipboard and preview accessibility', () => {
  beforeEach(() => {
    cleanup()
    vi.clearAllMocks()
    ;(Element.prototype as unknown as { scrollIntoView: () => void }).scrollIntoView = () => {}
  })

  it('copies the exact assistant reply through the available clipboard boundary (#46)', async () => {
    const user = userEvent.setup()
    const { bridgeWrite, browserWrite } = installApi()
    renderConversation()

    const copyActions = await screen.findAllByTitle('Copy')
    await user.click(copyActions[1]!)

    await waitFor(() => expect(browserWrite).toHaveBeenCalledWith('assistant reply copied exactly'))
    expect(bridgeWrite).toHaveBeenCalledWith('assistant reply copied exactly')
    expect(screen.getByText('Copied')).toBeTruthy()
  })

  it('does not report Copied when both clipboard boundaries fail', async () => {
    const user = userEvent.setup()
    const { bridgeWrite, browserWrite } = installApi()
    bridgeWrite.mockRejectedValueOnce(new Error('IPC unavailable'))
    browserWrite.mockRejectedValueOnce(new Error('clipboard permission denied'))
    renderConversation()

    const copyActions = await screen.findAllByTitle('Copy')
    await user.click(copyActions[0]!)

    await waitFor(() => expect(browserWrite).toHaveBeenCalledWith('copy this exact text'))
    expect(bridgeWrite).toHaveBeenCalledWith('copy this exact text')
    expect(screen.queryByText('Copied')).toBeNull()
  })

  it('exposes the image preview as a dialog and dismisses it from the keyboard or backdrop', async () => {
    installApi()
    const user = userEvent.setup()
    renderConversation()

    await user.click(await screen.findByAltText('Generated'))
    expect(screen.getByRole('dialog', { name: 'Generated image preview' })).toBeTruthy()
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog', { name: 'Generated image preview' })).toBeNull()

    await user.click(screen.getByAltText('Generated'))
    const dialog = screen.getByRole('dialog', { name: 'Generated image preview' })
    fireEvent.click(dialog)
    expect(screen.queryByRole('dialog', { name: 'Generated image preview' })).toBeNull()
  })
})
