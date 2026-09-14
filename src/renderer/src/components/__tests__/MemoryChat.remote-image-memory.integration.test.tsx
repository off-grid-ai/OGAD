// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ChatBoundary, installBoundary, renderChat, send } from './harness/chat-boundary'
import { resetTaskSessionStoreForTests } from '@renderer/lib/task-session-store'
import { closeTaskWorkspace } from '@renderer/lib/task-side-panel'
import type { ImageGenerationRequestContract } from '../../../../shared/image-generation-contract'

const refusal = new Error(
  'Error invoking remote method: Error: OFFGRID_IMAGE_MEMORY_LIMIT:Server needs more image memory.'
)

describe('<MemoryChat/> remote image memory refusal', () => {
  beforeEach(() => {
    resetTaskSessionStoreForTests()
    closeTaskWorkspace()
    ;(Element.prototype as unknown as { scrollIntoView(): void }).scrollIntoView = () => {}
    globalThis.requestAnimationFrame = (callback: FrameRequestCallback): number => {
      callback(0)
      return 1
    }
  })

  afterEach(() => {
    cleanup()
    closeTaskWorkspace()
    resetTaskSessionStoreForTests()
    vi.unstubAllGlobals()
  })

  function openChatWithRefusingServer(toolPrompt?: string): {
    boundary: ChatBoundary
    requests: ImageGenerationRequestContract[]
  } {
    const boundary = new ChatBoundary()
    const requests: ImageGenerationRequestContract[] = []
    installBoundary(boundary)
    if (toolPrompt) {
      window.api.getSettings = async () => ({ composerToolsOn: true })
      window.api.toolChat = async () => ({
        answer: 'I will make the illustration.',
        toolCalls: [{ name: 'generate_image', result: 'Image generation started' }],
        unified: [],
        imageRequests: [{ prompt: toolPrompt }]
      })
    }
    window.api.imageGenStatus = async () => ({
      available: true,
      models: [{ id: 'remote-image:server:flux', name: 'Flux' }],
      active: 'remote-image:server:flux'
    })
    window.api.generateImage = async (request) => {
      requests.push(request)
      if (!request.allowUnsafeMemoryOverride) throw refusal
      return {
        dataUrl: 'data:image/png;base64,iVBORw0KGgo=',
        path: '/synthetic/generated.png',
        syncId: 'synthetic-image',
        prompt: request.prompt,
        seed: 1,
        model: 'remote-image:server:flux'
      }
    }
    renderChat({ conversationId: 'conversation-a' })
    return { boundary, requests }
  }

  async function runAnyway(user: ReturnType<typeof userEvent.setup>): Promise<void> {
    expect(await screen.findByText('Server needs more image memory.')).toBeTruthy()
    await user.click(screen.getByRole('button', { name: 'Run anyway' }))
  }

  async function sendImagePrompt(text: string, user: ReturnType<typeof userEvent.setup>): Promise<void> {
    const input = await screen.findByPlaceholderText('Describe an image to generate…')
    ;(input as HTMLTextAreaElement).focus()
    await user.type(input, text, { skipClick: true })
    expect((input as HTMLTextAreaElement).value).toBe(text)
    const submit = screen.getByRole('button', { name: 'Send' })
    expect(submit.hasAttribute('disabled')).toBe(false)
    await user.click(submit)
  }

  it('retries a direct image request with the override only after the user acts', async () => {
    const { requests } = openChatWithRefusingServer()
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: 'Image' }))
    await sendImagePrompt('A moonlit coast', user)
    expect(await screen.findByText('A moonlit coast')).toBeTruthy()

    await waitFor(() => expect(requests).toHaveLength(1))
    expect(requests[0]?.allowUnsafeMemoryOverride).not.toBe(true)
    await runAnyway(user)
    await waitFor(() => expect(requests).toHaveLength(2))
    expect(requests[1]?.allowUnsafeMemoryOverride).toBe(true)
    expect(await screen.findByAltText('Generated')).toBeTruthy()
  })

  it('retries an image requested by a tool after showing the server refusal', async () => {
    const { requests } = openChatWithRefusingServer('A green valley')
    const user = userEvent.setup()
    await send('Plan the next step', user)

    await waitFor(() => expect(requests).toHaveLength(1))
    await runAnyway(user)
    await waitFor(() => expect(requests).toHaveLength(2))
    expect(requests[1]).toMatchObject({
      prompt: 'A green valley',
      allowUnsafeMemoryOverride: true
    })
    expect(await screen.findByAltText('Generated')).toBeTruthy()
  })

  it('retries a code-fence image after showing the server refusal', async () => {
    const { boundary, requests } = openChatWithRefusingServer()
    const user = userEvent.setup()
    await send('Describe the next step', user)
    await waitFor(() => expect(boundary.calls).toHaveLength(1))
    boundary.resolve(0, '```image\nA quiet forest\n```')

    await waitFor(() => expect(requests).toHaveLength(1))
    await runAnyway(user)
    await waitFor(() => expect(requests).toHaveLength(2))
    expect(requests[1]).toMatchObject({
      prompt: 'A quiet forest',
      allowUnsafeMemoryOverride: true
    })
    expect(await screen.findByAltText('Generated')).toBeTruthy()
  })

  it('shows a normal provider rejection without offering a memory override', async () => {
    const boundary = new ChatBoundary()
    installBoundary(boundary)
    window.api.generateImage = async () => {
      throw new Error('Provider rejected the image prompt.')
    }
    renderChat({ conversationId: 'conversation-a' })
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: 'Image' }))
    await sendImagePrompt('A moonlit coast', user)

    expect(await screen.findByText('Provider rejected the image prompt.')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Run anyway' })).toBeNull()
  })
})
