// @vitest-environment jsdom

import { createServer, type Server } from 'node:http'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'
import { testRemoteVisionServer } from '../../../../main/vision/remote-vision-server'
import { RemoteVisionSettingsTab } from '../RemoteVisionSettingsTab'

let server: Server | undefined

afterEach(async () => {
  cleanup()
  await new Promise<void>((resolve) => server?.close(() => resolve()) ?? resolve())
  server = undefined
})

async function showServer(response: { status: number; body: unknown }): Promise<void> {
  server = createServer((_request, result) => {
    result.writeHead(response.status, { 'Content-Type': 'application/json' })
    result.end(JSON.stringify(response.body))
  })
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Test server has no port')

  // Electron IPC is the external boundary. Discovery uses the real main-process owner.
  ;(window as unknown as { api: Record<string, unknown> }).api = {
    getRemoteVisionServer: async () => ({
      provider: 'local', endpoint: '', model: '', hasApiKey: false, activeServerId: null, servers: []
    }),
    testRemoteVisionServer
  }
  render(<RemoteVisionSettingsTab />)
  await screen.findByText('Local model is active.')
  fireEvent.click(screen.getByRole('button', { name: 'Add server' }))
  fireEvent.change(screen.getByLabelText('Address'), {
    target: { value: `http://127.0.0.1:${address.port}` }
  })
  fireEvent.click(screen.getByRole('button', { name: 'Test connection' }))
}

describe('remote model discovery from Settings', () => {
  it('shows each model type returned by a reachable server', async () => {
    await showServer({
      status: 200,
      body: {
        data: [
          { id: 'chat', kind: 'chat' },
          { id: 'picture', kind: 'image' },
          { id: 'listener', kind: 'transcription' },
          { id: 'speaker', kind: 'speech' },
          { id: 'inferred-picture', architecture: { output_modalities: ['image'] } },
          { id: 'inferred-listener', architecture: { input_modalities: ['audio'], output_modalities: ['text'] } },
          { id: 'inferred-speaker', architecture: { output_modalities: ['audio'] } }
        ]
      }
    })

    expect(await screen.findByText(/7 models found/)).toBeTruthy()
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'image model' }))
    expect(screen.getByRole('menuitemradio', { name: 'picture' })).toBeTruthy()
    expect(screen.getByRole('menuitemradio', { name: 'inferred-picture' })).toBeTruthy()
    await user.keyboard('{Escape}')
    await user.click(screen.getByRole('button', { name: 'transcription model' }))
    expect(screen.getByRole('menuitemradio', { name: 'listener' })).toBeTruthy()
    expect(screen.getByRole('menuitemradio', { name: 'inferred-listener' })).toBeTruthy()
    await user.keyboard('{Escape}')
    await user.click(screen.getByRole('button', { name: 'voice model' }))
    expect(screen.getByRole('menuitemradio', { name: 'speaker' })).toBeTruthy()
    expect(screen.getByRole('menuitemradio', { name: 'inferred-speaker' })).toBeTruthy()
  })

  it('shows a reachable server’s rejection reason', async () => {
    await showServer({ status: 403, body: { error: { message: 'This account cannot list models.' } } })
    expect(await screen.findByText('This account cannot list models.')).toBeTruthy()
  })
})
