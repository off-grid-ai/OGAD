// @vitest-environment jsdom
// Real chat, message projection, menus and storage adapter. Only the preload
// boundary substitutes for Electron/native video; assertions inspect user output
// and stored rows, never mock calls or component internals.
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ChatBoundary, installBoundary, renderChat } from './harness/chat-boundary'
import { clearRegisteredSlots } from '../../bootstrap/slotRegistry'
import { resetTaskSessionStoreForTests } from '../../lib/task-session-store'

beforeEach(() => {
  Element.prototype.scrollIntoView = () => {}
  resetTaskSessionStoreForTests()
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  clearRegisteredSlots()
})

it('blocks Resend during engine shutdown and a still-pending cancel acknowledgement without losing the turn', async () => {
  const boundary = new ChatBoundary()
  boundary.messages['conversation-a'] = [
    { id: 1, role: 'user', content: 'Earlier question', created_at: '2026-01-01 08:00:00' },
    {
      id: 2,
      role: 'assistant',
      content: 'Keep the earlier answer',
      created_at: '2026-01-01 08:00:01'
    }
  ]
  let failGeneration!: (error: Error) => void
  let acknowledgeCancel!: (result: boolean) => void
  let stopping = false
  const generation = new Promise<never>((_resolve, reject) => {
    failGeneration = reject
  })
  const cancellation = new Promise<boolean>((resolve) => {
    acknowledgeCancel = resolve
  })
  Object.assign(boundary.api, {
    videoGenStatus: async () => ({ available: true, models: ['wan'], active: 'wan' }),
    generateVideo: () => generation,
    cancelVideoGen: () => {
      stopping = true
      return cancellation
    }
  })
  installBoundary(boundary)
  const user = userEvent.setup()
  renderChat({ conversationId: 'conversation-a' })
  await screen.findByPlaceholderText(/Ask about.*Project Alpha/)
  await user.click(await screen.findByRole('button', { name: /^Video$/ }))
  const textarea = screen.getByPlaceholderText('Describe a video to generate…')
  textarea.focus()
  await user.type(textarea, 'Keep this video prompt', { skipClick: true })
  await user.click(screen.getByRole('button', { name: /^Send$/ }))
  await screen.findByRole('button', { name: 'Stop generating' })
  await waitFor(() => expect(boundary.messages['conversation-a']).toHaveLength(3))
  const before = structuredClone(boundary.messages['conversation-a'])
  await user.click(screen.getByRole('button', { name: 'Stop generating' }))
  expect(stopping).toBe(true)
  // Target the earlier user turn: an unsafe Resend would delete its answer and
  // the current video prompt, so this observes actual history loss.
  fireEvent.pointerDown(screen.getAllByRole('button', { name: 'Message actions' })[0]!, {
    button: 0,
    ctrlKey: false
  })
  const busyResend = await screen.findByRole('menuitem', { name: 'Resend' })
  expect(busyResend.getAttribute('aria-disabled')).toBe('true')
  fireEvent.click(busyResend)
  expect(boundary.messages['conversation-a']).toEqual(before)
  await user.keyboard('{Escape}')
  await act(async () => {
    failGeneration(new Error('Video generation stopped.'))
    await generation.catch(() => {})
  })
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Stop generating' })).toBeNull())
  fireEvent.pointerDown(screen.getAllByRole('button', { name: 'Message actions' })[0]!, {
    button: 0,
    ctrlKey: false
  })
  await user.click(await screen.findByRole('menuitem', { name: 'Resend' }))
  expect(boundary.messages['conversation-a']).toEqual(before)
  expect(screen.queryByText('Preparing video…')).toBeNull()
  await act(async () => {
    acknowledgeCancel(true)
    await cancellation
  })
})

it('opens saved video details after remount when the old row has no metrics object', async () => {
  const boundary = new ChatBoundary()
  Object.assign(boundary.api, { getSettings: async () => ({ showGenerationDetails: true }) })
  boundary.messages['conversation-a'] = [
    {
      id: 21,
      role: 'assistant',
      content: 'Saved lake video',
      created_at: '2026-01-01 09:41:00',
      context: {
        videoRef: { id: 'saved-video', path: '/generated-videos/lake.mp4' },
        durationMs: 1200,
        videoMetadata: {
          model: 'wan',
          width: 320,
          height: 192,
          frames: 17,
          fps: 8,
          durationSeconds: 2.125,
          steps: 20,
          guidance: 6,
          seed: 42,
          negativePrompt: ''
        }
      }
    }
  ]
  installBoundary(boundary)
  const original = structuredClone(boundary.messages['conversation-a'])
  const first = renderChat({ conversationId: 'conversation-a' })
  await screen.findByRole('button', { name: 'Generation details' })
  first.unmount()
  renderChat({ conversationId: 'conversation-a' })
  await userEvent.setup().click(await screen.findByRole('button', { name: 'Generation details' }))
  const details = await screen.findByTestId('generation-metrics')
  for (const part of ['320 × 192', '2.125s video', '8 fps', '17 frames', 'wan', '1.2'])
    expect(details.textContent).toContain(part)
  expect(boundary.messages['conversation-a']).toEqual(original)
})

it('renders old native errors as recovery copy without rewriting saved history', async () => {
  const boundary = new ChatBoundary()
  const raw =
    "Error invoking remote method 'videogen:generate': tensor extends beyond its model file /private/models/weights"
  boundary.messages['conversation-a'] = [
    { id: 21, role: 'assistant', content: raw, created_at: '2026-01-01 09:41:00' }
  ]
  installBoundary(boundary)
  renderChat({ conversationId: 'conversation-a' })
  await screen.findByText(/The video model could not load/)
  expect(screen.queryByText(/tensor extends beyond/)).toBeNull()
  expect(boundary.messages['conversation-a']![0]!.content).toBe(raw)
})
