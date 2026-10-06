// @vitest-environment jsdom
//
// Answer versions (‹ 1/2 ›), as the browser extension keeps them, end to end through the real chat:
// Regenerate and Resend both keep the answer they replace; the arrows show that version's own
// text (they used to change the counter alone); the version shown is saved, and every version is
// still there when the chat is opened again. Only the preload boundary is faked.

import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChatBoundary, installBoundary, renderChat, send } from './harness/chat-boundary'

function setup(): { boundary: ChatBoundary; user: ReturnType<typeof userEvent.setup> } {
  const boundary = new ChatBoundary()
  Object.assign(boundary.api, {
    getSettings: async () => ({}),
    saveSetting: async () => true,
    listTools: async () => [],
    mcpList: async () => []
  })
  installBoundary(boundary)
  return { boundary, user: userEvent.setup() }
}

const row = (text: string): HTMLElement =>
  screen.getByText(text).closest('[data-testid^="chat-message-"]') as HTMLElement

async function openMenu(message: HTMLElement): Promise<void> {
  fireEvent.pointerDown(within(message).getByRole('button', { name: 'Message actions' }), {
    button: 0,
    ctrlKey: false
  })
}

async function firstAnswer(boundary: ChatBoundary, user: ReturnType<typeof userEvent.setup>) {
  renderChat({ conversationId: 'conversation-a' })
  await send('name a colour', user)
  await waitFor(() => expect(boundary.calls).toHaveLength(1))
  boundary.resolve(0, 'Red.')
  expect(await screen.findByText('Red.')).toBeTruthy()
}

describe('<MemoryChat/> answer versions', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(Element.prototype as unknown as { scrollIntoView: () => void }).scrollIntoView = () => {}
  })
  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  it('Regenerate keeps the earlier answer, and the arrows show its own text', async () => {
    const { boundary, user } = setup()
    await firstAnswer(boundary, user)

    await openMenu(row('Red.'))
    await user.click(await screen.findByRole('menuitem', { name: 'Regenerate' }))
    await waitFor(() => expect(boundary.calls).toHaveLength(2))
    boundary.resolve(1, 'Blue.')
    expect(await screen.findByText('Blue.')).toBeTruthy()
    expect(screen.getByText('2/2')).toBeTruthy()

    await user.click(screen.getByRole('button', { name: 'Previous version' }))
    expect(await screen.findByText('Red.')).toBeTruthy()
    expect(screen.queryByText('Blue.')).toBeNull()
    expect(screen.getByText('1/2')).toBeTruthy()
    expect(boundary.api.showRagMessageVersion).toHaveBeenCalledWith(
      'conversation-a',
      expect.any(String),
      { variants: ['Red.', 'Blue.'], variantIndex: 0 }
    )
  })

  it('Resend on the question keeps the answer it replaces too', async () => {
    const { boundary, user } = setup()
    await firstAnswer(boundary, user)

    await openMenu(row('name a colour'))
    await user.click(await screen.findByRole('menuitem', { name: 'Resend' }))
    await waitFor(() => expect(boundary.calls).toHaveLength(2))
    boundary.resolve(1, 'Green.')
    expect(await screen.findByText('Green.')).toBeTruthy()
    expect(screen.getByText('2/2')).toBeTruthy()
    await user.click(screen.getByRole('button', { name: 'Previous version' }))
    expect(await screen.findByText('Red.')).toBeTruthy()
  })

  it('saves every version with the answer, so they are there when the chat is opened again', async () => {
    const { boundary, user } = setup()
    await firstAnswer(boundary, user)
    await openMenu(row('Red.'))
    await user.click(await screen.findByRole('menuitem', { name: 'Regenerate' }))
    await waitFor(() => expect(boundary.calls).toHaveLength(2))
    boundary.resolve(1, 'Blue.')
    expect(await screen.findByText('Blue.')).toBeTruthy()
    await waitFor(() =>
      expect(boundary.messages['conversation-a']?.at(-1)?.context).toMatchObject({
        variants: ['Red.', 'Blue.'],
        variantIndex: 1
      })
    )

    cleanup()
    renderChat({ conversationId: 'conversation-a' })
    expect(await screen.findByText('Blue.')).toBeTruthy()
    expect(screen.getByText('2/2')).toBeTruthy()
    await user.click(screen.getByRole('button', { name: 'Previous version' }))
    expect(await screen.findByText('Red.')).toBeTruthy()
  })
})
