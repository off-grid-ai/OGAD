// @vitest-environment jsdom

import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, it } from 'vitest'
import { ChatBoundary, installBoundary, renderChat } from './harness/chat-boundary'

afterEach(cleanup)

it('keeps a message edit in its editor and sends the saved text', async () => {
  const boundary = new ChatBoundary()
  await boundary.addRagMessage('conversation-a', 'user', 'Original question')
  await boundary.addRagMessage('conversation-a', 'assistant', 'Original answer')
  installBoundary(boundary)
  const user = userEvent.setup()
  renderChat({ conversationId: 'conversation-a' })

  const question = await screen.findByText('Original question')
  const questionRow = question.closest('[data-testid^="chat-message-"]')!
  fireEvent.pointerDown(within(questionRow as HTMLElement).getByRole('button', { name: 'Message actions' }), {
    button: 0,
    ctrlKey: false
  })
  await user.click(await screen.findByRole('menuitem', { name: 'Edit' }))
  const editor = screen.getByDisplayValue('Original question')
  await user.clear(editor)
  await user.type(editor, 'Updated question')
  expect(screen.getByText('Original answer')).toBeTruthy()
  await user.click(screen.getByRole('button', { name: 'Save & submit' }))

  await waitFor(() => expect(boundary.calls).toHaveLength(1))
  expect(boundary.calls[0]!.query).toBe('Updated question')
  await act(async () => boundary.resolve(0, 'Updated answer'))
  expect(await screen.findByText('Updated question')).toBeTruthy()
  expect(await screen.findByText('Updated answer')).toBeTruthy()
})
