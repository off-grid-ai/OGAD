// @vitest-environment jsdom

import { createServer } from 'node:http'
import { cleanup, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'
import { generateRemoteImage } from '../../../../main/remote-media-runtime'
import type { ImageGenerationRequestContract } from '../../../../shared/image-generation-contract'
import { ChatBoundary, installBoundary, renderChat } from './harness/chat-boundary'

const imageBytes = Buffer.from('synthetic image bytes')

afterEach(() => cleanup())

describe('<MemoryChat/> with a remote image provider', () => {
  it('shows the provider memory refusal and generates after Run anyway', async () => {
    const requests: boolean[] = []
    const provider = createServer(async (request, response) => {
      if (request.method === 'GET') {
        response.writeHead(200, { 'Content-Type': 'image/png' })
        response.end(imageBytes)
        return
      }
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(Buffer.from(chunk))
      const body = JSON.parse(Buffer.concat(chunks).toString()) as { prompt: string; allow_unsafe_memory_override?: boolean }
      requests.push(body.allow_unsafe_memory_override === true)
      response.setHeader('Content-Type', 'application/json')
      if (!body.allow_unsafe_memory_override && body.prompt === 'A green coast') {
        response.writeHead(409)
        response.end(JSON.stringify({ error: { code: 'OFFGRID_IMAGE_MEMORY_LIMIT', message: 'Server needs more image memory.' } }))
      } else if (body.prompt === 'A green coast') {
        const address = provider.address()
        if (!address || typeof address === 'string') throw new Error('Test provider has no port')
        response.end(JSON.stringify({ data: [{ url: `http://127.0.0.1:${address.port}/image.png` }] }))
      } else {
        response.end(JSON.stringify({ data: [{ b64_json: imageBytes.toString('base64') }] }))
      }
    })
    await new Promise<void>((resolve) => provider.listen(0, '127.0.0.1', resolve))
    try {
      const address = provider.address()
      if (!address || typeof address === 'string') throw new Error('Test provider has no port')
      const server: Parameters<typeof generateRemoteImage>[0] = {
        id: 'provider', name: 'Image provider', provider: 'custom',
        endpoint: `http://127.0.0.1:${address.port}/v1`, model: '',
        enabled: true, mediaModels: { image: 'image-maker' }, modelCatalog: [],
        screenFramesAllowed: false, apiKey: '', selectedModel: 'image-maker'
      }
      const boundary = new ChatBoundary()
      installBoundary(boundary)
      window.api.imageGenStatus = async () => ({
        available: true,
        models: [{ id: 'remote-image:provider:image-maker', name: 'Image Maker' }],
        active: 'remote-image:provider:image-maker'
      })
      window.api.generateImage = async (request: ImageGenerationRequestContract) => {
        const result = await generateRemoteImage(
          server, request.prompt, request.width, request.height,
          request.allowUnsafeMemoryOverride === true
        )
        return {
          dataUrl: `data:${result.mime};base64,${result.bytes.toString('base64')}`,
          path: '/synthetic/generated.png', syncId: 'synthetic-image',
          prompt: request.prompt, seed: 1, model: 'remote-image:provider:image-maker'
        }
      }
      ;(Element.prototype as unknown as { scrollIntoView(): void }).scrollIntoView = () => {}
      globalThis.requestAnimationFrame = (callback: FrameRequestCallback): number => {
        callback(0)
        return 1
      }
      renderChat({ conversationId: 'conversation-a' })
      const user = userEvent.setup()
      await user.click(await screen.findByRole('button', { name: 'Image' }))
      const input = await screen.findByPlaceholderText('Describe an image to generate…')
      ;(input as HTMLTextAreaElement).focus()
      await user.type(input, 'A green coast', { skipClick: true })
      await user.click(screen.getByRole('button', { name: 'Send' }))

      await waitFor(() => expect(requests).toEqual([false]))
      expect(await screen.findByText('Server needs more image memory.')).toBeTruthy()
      await user.click(screen.getByRole('button', { name: 'Run anyway' }))
      expect(await screen.findByAltText('Generated')).toBeTruthy()
      await waitFor(() => expect(requests).toEqual([false, true]))

      const next = await screen.findByPlaceholderText('Describe an image to generate…')
      ;(next as HTMLTextAreaElement).focus()
      await user.type(next, 'A blue coast', { skipClick: true })
      await user.click(screen.getByRole('button', { name: 'Send' }))
      await waitFor(() => expect(screen.getAllByAltText('Generated')).toHaveLength(2))
    } finally {
      await new Promise<void>((resolve) => provider.close(() => resolve()))
    }
  })
})
