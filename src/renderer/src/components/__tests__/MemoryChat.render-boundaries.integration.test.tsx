// @vitest-environment jsdom

import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { ChatBoundary, installBoundary, renderChat, send } from './harness/chat-boundary'

const originalOffsetHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight')
beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
    configurable: true,
    get() {
      return this.classList.contains('overflow-y-auto') ? 600 : 0
    }
  })
})
afterEach(() => {
  cleanup()
  if (originalOffsetHeight) {
    Object.defineProperty(HTMLElement.prototype, 'offsetHeight', originalOffsetHeight)
  }
})

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

it('shows a completed artifact card without its raw HTML', async () => {
  const boundary = new ChatBoundary()
  await boundary.addRagMessage(
    'conversation-a',
    'assistant',
    '```html\n<!doctype html><html><body>ARTIFACT_ONLY_MARKER</body></html>\n```'
  )
  installBoundary(boundary)
  renderChat({ conversationId: 'conversation-a' })

  expect(await screen.findByRole('button', { name: /HTML artifact/i })).toBeTruthy()
  expect(screen.queryByText(/ARTIFACT_ONLY_MARKER/)).toBeNull()
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

it.each([
  [
    'on a later line',
    'Please improve this draft.\n/proo',
    'Please improve this draft.\n/proofread ',
    'Please improve this draft.'
  ],
  ['after text', 'hello /proo', 'hello /proofread ', 'hello']
])('completes and opens an installed skill %s', async (_, draft, completed, prompt) => {
  const boundary = new ChatBoundary()
  Object.assign(boundary.api, {
    listSkills: async () => [{ name: 'proofread', description: 'Improve writing' }],
    getSkill: async (name: string) =>
      name === 'proofread'
        ? {
            name,
            description: 'Improve writing',
            instructions: 'Preserve the meaning.',
            trigger: null
          }
        : null
  })
  installBoundary(boundary)
  const user = userEvent.setup()
  renderChat({ conversationId: 'conversation-a' })

  const composer = await screen.findByPlaceholderText('Ask about “Project Alpha”…')
  fireEvent.change(composer, { target: { value: draft } })
  expect(await screen.findByRole('button', { name: /proofread/i })).toBeTruthy()
  fireEvent.keyDown(composer, { key: 'Tab' })
  expect((composer as HTMLTextAreaElement).value).toBe(completed)
  await user.click(screen.getByRole('button', { name: 'Send' }))

  await waitFor(() => expect(boundary.calls).toHaveLength(1))
  expect(boundary.calls[0]!.query).toContain('Preserve the meaning.')
  expect(boundary.calls[0]!.query).toContain(prompt)
  await act(async () => boundary.resolve(0, 'The draft is clearer.'))
  await user.click(await screen.findByRole('button', { name: 'Open /proofread skill' }))
  const panel = await screen.findByRole('dialog', { name: 'Skills' })
  expect(within(panel).getByDisplayValue('proofread')).toBeTruthy()
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

it('switches between saved chats and shows a peer update to an inactive chat', async () => {
  const boundary = new ChatBoundary()
  await boundary.addRagMessage('conversation-a', 'assistant', 'Answer in the first chat')
  boundary.blockConversationRead('conversation-b')
  installBoundary(boundary)
  const user = userEvent.setup()
  renderChat({ conversationId: 'conversation-a' })

  expect(await screen.findByText('Answer in the first chat')).toBeTruthy()
  const conversationList = screen.getByRole('complementary')
  const conversationBRow = within(conversationList)
    .getByText('Conversation B')
    .closest('[role="button"]') as HTMLElement
  conversationBRow.focus()
  await user.keyboard('{Enter}')
  expect(await screen.findByRole('status', { name: 'Loading conversation' })).toBeTruthy()
  boundary.releaseConversationRead('conversation-b')
  expect(await screen.findByText('Conversation B baseline')).toBeTruthy()
  expect(screen.queryByRole('status', { name: 'Loading conversation' })).toBeNull()
  expect(screen.getAllByTitle('Close tab')).toHaveLength(1)
  expect(screen.getByTitle('Close tab').parentElement?.textContent).toContain('Conversation B')
  await user.click(screen.getByTitle('New tab'))
  expect(await screen.findByText('Start a conversation')).toBeTruthy()
  expect(screen.queryByRole('status', { name: 'Loading conversation' })).toBeNull()
  await user.click(within(conversationList).getByText('Conversation A'))
  expect(await screen.findByRole('status', { name: 'Loading conversation' })).toBeTruthy()
  expect(await screen.findByText('Answer in the first chat')).toBeTruthy()
  expect(screen.getAllByTitle('Close tab')).toHaveLength(2)
  const conversationBTab = screen
    .getAllByTitle('Close tab')
    .find((close) => close.parentElement?.textContent?.includes('Conversation B'))!.parentElement!
  await user.click(within(conversationBTab).getByRole('button', { name: 'Conversation B' }))
  expect(await screen.findByText('Conversation B baseline')).toBeTruthy()
  expect(screen.getAllByTitle('Close tab')).toHaveLength(2)
  const conversationATab = screen
    .getAllByTitle('Close tab')
    .find((close) => close.parentElement?.textContent?.includes('Conversation A'))!.parentElement!
  await user.click(within(conversationATab).getByRole('button', { name: 'Conversation A' }))
  expect(await screen.findByText('Answer in the first chat')).toBeTruthy()

  await boundary.addRagMessage('conversation-b', 'assistant', 'A peer added this answer')
  await act(async () => boundary.emitConversationChanged('conversation-b'))
  await user.click(within(conversationList).getByText('Conversation B'))
  expect(await screen.findByText('A peer added this answer')).toBeTruthy()
  expect(screen.queryByText('Answer in the first chat')).toBeNull()
  expect(screen.getAllByTitle('Close tab')).toHaveLength(1)
  expect(screen.getByTitle('Close tab').parentElement?.textContent).toContain('Conversation B')
})
