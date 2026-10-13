// @vitest-environment jsdom
import { act, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, it } from 'vitest'
import { ChatBoundary, installBoundary, renderChat, send } from './harness/chat-boundary'

it('deletes only the selected queued message and keeps the composer draft', async () => {
  const boundary = new ChatBoundary()
  installBoundary(boundary)
  const user = userEvent.setup()
  renderChat({ conversationId: 'conversation-a' })

  await send('First question', user)
  await waitFor(() => expect(boundary.calls).toHaveLength(1))
  await send('Keep this question', user)
  await send('Delete this question', user)
  const composer = screen.getByPlaceholderText(/^ask /i)
  await user.type(composer, 'Unsent draft')

  const row = screen.getByRole('group', { name: 'Queued message 2' })
  await user.click(within(row).getByRole('button', { name: 'Delete queued message' }))

  expect(screen.queryByText('Delete this question')).toBeNull()
  expect(screen.getByText('Keep this question')).toBeTruthy()
  expect((composer as HTMLTextAreaElement).value).toBe('Unsent draft')
  await act(async () => boundary.resolve(0, 'First answer'))
  await waitFor(() => expect(boundary.calls).toHaveLength(2))
  expect(boundary.calls.map((call) => call.query)).toEqual(['First question', 'Keep this question'])
  await act(async () => boundary.resolve(1, 'Kept answer'))
  await screen.findByText('Kept answer')
  expect(screen.queryByRole('group', { name: /Queued message/ })).toBeNull()
})

it('sends a selected queued message first through Enter and keeps the other message queued', async () => {
  const boundary = new ChatBoundary()
  installBoundary(boundary)
  const user = userEvent.setup()
  renderChat({ conversationId: 'conversation-a' })

  await send('Current question', user)
  await waitFor(() => expect(boundary.calls).toHaveLength(1))
  await send('Later question', user)
  await send('Send this now', user)
  const composer = screen.getByPlaceholderText(/^ask /i)
  await user.type(composer, 'Unsent draft')

  const row = screen.getByRole('group', { name: 'Queued message 2' })
  within(row).getByRole('button', { name: 'Send queued message now' }).focus()
  await user.keyboard('{Enter}')

  await waitFor(() => expect(boundary.calls).toHaveLength(2))
  expect(boundary.calls[1]!.query).toBe('Send this now')
  expect((composer as HTMLTextAreaElement).value).toBe('Unsent draft')
  expect(screen.getByText('Later question')).toBeTruthy()
  await act(async () => boundary.resolve(1, 'Immediate answer'))
  await waitFor(() => expect(boundary.calls).toHaveLength(3))
  expect(boundary.calls[2]!.query).toBe('Later question')
  await act(async () => boundary.resolve(2, 'Later answer'))
  await screen.findByText('Later answer')
  expect(
    boundary.messages['conversation-a']!.filter(
      (message) => message.role === 'user' && message.content === 'Send this now'
    )
  ).toHaveLength(1)
})
