// @vitest-environment jsdom
import { cleanup, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetTaskSessionStoreForTests } from '../../lib/task-session-store'
import { clearRegisteredSlots } from '../../bootstrap/slotRegistry'
import { ChatBoundary, installBoundary, renderChat, send } from './harness/chat-boundary'

const video = {
  path: '/generated-videos/lake.mp4',
  syncId: 'video-lake',
  prompt: 'A quiet lake',
  negativePrompt: '',
  model: 'wan',
  width: 320,
  height: 192,
  frames: 17,
  fps: 8,
  steps: 20,
  guidance: 6,
  seed: 42,
  durationSeconds: 2.125,
  durationMs: 1200
}

function setup(): ChatBoundary {
  const boundary = new ChatBoundary()
  Object.assign(boundary.api, {
    videoGenStatus: async () => ({ available: true, models: [], active: null }),
    generateVideo: async () => video
  })
  installBoundary(boundary)
  return boundary
}

beforeEach(() => {
  vi.clearAllMocks()
  Element.prototype.scrollIntoView = () => {}
  globalThis.requestAnimationFrame = (callback) => {
    callback(0)
    return 1
  }
  resetTaskSessionStoreForTests()
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  clearRegisteredSlots()
})

describe('video generation in a real chat', () => {
  it('saves a direct generation and restores its player after remount', async () => {
    const boundary = setup()
    const user = userEvent.setup()
    const view = renderChat({ conversationId: 'conversation-a' })
    await screen.findByPlaceholderText(/Ask about.*Project Alpha/)
    await user.click(await screen.findByRole('button', { name: /^Video$/ }))
    const textarea = screen.getByPlaceholderText('Describe a video to generate…')
    textarea.focus()
    await user.type(textarea, 'A quiet lake', { skipClick: true })
    await user.click(screen.getByRole('button', { name: /^send$/i }))
    await waitFor(() => expect(view.container.querySelector('video')).not.toBeNull())
    expect(boundary.messages['conversation-a']![0]).toMatchObject({
      role: 'user',
      content: 'A quiet lake'
    })
    expect(boundary.messages['conversation-a']!.filter((m) => m.role === 'assistant')).toEqual([
      expect.objectContaining({
        context: expect.objectContaining({
          videoRef: { id: video.syncId, path: video.path },
          videoMetadata: expect.objectContaining({ fps: 8, frames: 17 })
        })
      })
    ])
    await waitFor(() =>
      expect(view.container.querySelector('video')?.getAttribute('src')).toContain('/video.mp4')
    )
    const saved = structuredClone(boundary.messages['conversation-a'])
    view.unmount()
    const restored = renderChat({ conversationId: 'conversation-a' })
    await waitFor(() =>
      expect(restored.container.querySelector('media-play-button')).not.toBeNull()
    )
    expect(restored.container.querySelector('video')?.getAttribute('src')).toContain('/video.mp4')
    expect(boundary.messages['conversation-a']).toEqual(saved)
  })

  it('runs a deferred generate_video request and persists its chat reference', async () => {
    const boundary = setup()
    const user = userEvent.setup()
    const view = renderChat({ conversationId: 'conversation-a' })
    await send('Make a lake video', user)
    await waitFor(() => expect(boundary.calls).toHaveLength(1))
    boundary.resolve(0, 'Here is the lake.', {
      videoRequests: [{ prompt: 'A quiet lake', enhancePrompt: false }],
      toolCalls: [{ name: 'generate_video', result: 'Queued', status: 'completed' }]
    })
    await waitFor(() => expect(view.container.querySelector('video')).not.toBeNull())
    expect(boundary.messages['conversation-a']!.filter((m) => m.role === 'assistant')).toEqual([
      expect.objectContaining({
        context: expect.objectContaining({ videoRef: { id: video.syncId, path: video.path } })
      })
    ])
  })

  it('shows a generation failure without storing a broken video reference', async () => {
    const boundary = setup()
    Object.assign(boundary.api, {
      generateVideo: async () => {
        throw new Error('Video encoder failed')
      }
    })
    const user = userEvent.setup()
    renderChat({ conversationId: 'conversation-a' })
    await screen.findByPlaceholderText(/Ask about.*Project Alpha/)
    await user.click(await screen.findByRole('button', { name: /^Video$/ }))
    const textarea = screen.getByPlaceholderText('Describe a video to generate…')
    textarea.focus()
    await user.type(textarea, 'A quiet lake', { skipClick: true })
    await user.click(screen.getByRole('button', { name: /^send$/i }))
    await screen.findByText(
      'Video generation failed. Check the selected video model, then try again. Technical details are in the app log.'
    )
    expect(boundary.messages['conversation-a']!.filter((m) => m.role === 'assistant')).toEqual([
      expect.objectContaining({
        content:
          'Video generation failed. Check the selected video model, then try again. Technical details are in the app log.',
        context: undefined
      })
    ])
  })
})
