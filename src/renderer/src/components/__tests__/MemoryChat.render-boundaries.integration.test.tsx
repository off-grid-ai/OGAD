// @vitest-environment jsdom

import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, it } from 'vitest'
import { ChatBoundary, installBoundary, renderChat, send } from './harness/chat-boundary'

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
  fireEvent.pointerDown(
    within(questionRow as HTMLElement).getByRole('button', { name: 'Message actions' }),
    {
      button: 0,
      ctrlKey: false
    }
  )
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

it('completes a skill in the draft and sends it from a populated chat', async () => {
  const boundary = new ChatBoundary()
  await boundary.addRagMessage('conversation-a', 'assistant', 'Earlier answer')
  Object.assign(boundary.api, {
    listSkills: async () => [{ name: 'summarize', description: 'Summarize text' }]
  })
  installBoundary(boundary)
  const user = userEvent.setup()
  renderChat({ conversationId: 'conversation-a' })

  await screen.findByText('Earlier answer')
  const composer = await screen.findByPlaceholderText('Ask about “Project Alpha”…')
  fireEvent.change(composer, { target: { value: '/summ' } })
  expect(await screen.findByRole('button', { name: /summarize/i })).toBeTruthy()
  fireEvent.keyDown(composer, { key: 'Tab' })
  expect((composer as HTMLTextAreaElement).value).toBe('/summarize ')
  fireEvent.change(composer, { target: { value: '/summarize the release' } })
  await user.click(screen.getByRole('button', { name: 'Send' }))

  await waitFor(() => expect(boundary.calls).toHaveLength(1))
  expect(boundary.calls[0]!.query).toBe('/summarize the release')
  await act(async () => boundary.resolve(0, 'Release summary'))
  expect(await screen.findByText('Release summary')).toBeTruthy()
  expect(screen.getByText('Earlier answer')).toBeTruthy()
})

it('creates a project from the composer and sends into it', async () => {
  const boundary = new ChatBoundary()
  Object.assign(boundary.api, {
    createProject: async ({ name }: { name: string }) => {
      boundary.projects.push({ id: 'project-new', name })
      return 'project-new'
    }
  })
  installBoundary(boundary)
  const user = userEvent.setup()
  renderChat({ conversationId: 'conversation-a' })

  const scope = await screen.findByTitle(/choose what this chat can draw on/i)
  scope.focus()
  await user.keyboard('{Enter}')
  await user.click(await screen.findByRole('menuitem', { name: 'New project' }))
  const name = await screen.findByPlaceholderText(/New project name/)
  await waitFor(() => expect(document.activeElement).toBe(name))
  await user.type(name, 'Release notes{Enter}')
  expect(await screen.findByText('In Release notes')).toBeTruthy()

  await send('What changed?', user)
  await waitFor(() => expect(boundary.calls).toHaveLength(1))
  expect(boundary.calls[0]!.projectId).toBe('project-new')
  await act(async () => boundary.resolve(0, 'The Desktop chat changed.'))
  expect(await screen.findByText('The Desktop chat changed.')).toBeTruthy()
})
