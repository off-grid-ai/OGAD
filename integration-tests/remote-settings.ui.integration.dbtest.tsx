// @vitest-environment jsdom

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import React from 'react'
import { createServer, type Server } from 'node:http'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-remote-settings-ui-'))
const previousDataDir = process.env.OFFGRID_DATA_DIR
process.env.OFFGRID_DATA_DIR = profile

vi.mock('electron', () => ({
  app: { getPath: () => profile, isPackaged: false, getAppPath: () => process.cwd() },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString()
  }
}))

import {
  getActiveRemoteVisionServerForModality,
  getRemoteVisionServerSettings,
  removeRemoteVisionServer,
  setRemoteVisionServerSettings,
  testRemoteVisionServer
} from '../src/main/vision/remote-vision-server'
import { generateImage } from '../src/main/imagegen'
import { RemoteVisionSettingsTab } from '../src/renderer/src/components/RemoteVisionSettingsTab'

let provider: Server | undefined

afterEach(async () => {
  cleanup()
  if (provider) await new Promise<void>((resolve) => provider!.close(() => resolve()))
  provider = undefined
})

afterAll(() => {
  if (previousDataDir === undefined) delete process.env.OFFGRID_DATA_DIR
  else process.env.OFFGRID_DATA_DIR = previousDataDir
  fs.rmSync(profile, { recursive: true, force: true })
})

describe('remote media choices in Desktop Settings', () => {
  it('saves a media-only server, turns it off, then restores and removes it', async () => {
    const generated = Buffer.from('generated image bytes')
    provider = createServer((request, response) => {
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify(request.method === 'POST'
        ? { data: [{ b64_json: generated.toString('base64') }] }
        : { data: [
            { id: 'picture', kind: 'image' },
            { id: 'listener', kind: 'transcription' },
            { id: 'speaker', kind: 'speech' }
          ] }))
    })
    await new Promise<void>((resolve) => provider!.listen(0, '127.0.0.1', resolve))
    const address = provider.address()
    if (!address || typeof address === 'string') throw new Error('Provider has no port')

    // Electron IPC is the external boundary; Settings and its main-process owner stay real.
    ;(window as unknown as { api: Record<string, unknown> }).api = {
      getRemoteVisionServer: async () => getRemoteVisionServerSettings(),
      testRemoteVisionServer,
      setRemoteVisionServer: async (value: Parameters<typeof setRemoteVisionServerSettings>[0]) =>
        setRemoteVisionServerSettings(value),
      removeRemoteVisionServer: async (id: string) => removeRemoteVisionServer(id)
    }
    render(<RemoteVisionSettingsTab />)
    await screen.findByText('Local model is active.')
    fireEvent.click(screen.getByRole('button', { name: 'Add server' }))
    fireEvent.change(screen.getByLabelText('Server name'), { target: { value: 'Studio' } })
    fireEvent.change(screen.getByLabelText('Address'), { target: { value: `http://127.0.0.1:${address.port}` } })
    fireEvent.click(screen.getByRole('button', { name: 'Test connection' }))
    await screen.findByText(/3 models found/)
    fireEvent.change(screen.getByLabelText('Image'), { target: { value: 'picture' } })
    fireEvent.change(screen.getByLabelText('Transcription'), { target: { value: 'listener' } })
    fireEvent.change(screen.getByLabelText('Voice'), { target: { value: 'speaker' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await screen.findByText('Server saved and active.')

    const saved = getRemoteVisionServerSettings()
    expect(saved.activeServerId).toBeTruthy()
    expect(saved.model).toBe('')
    expect(getActiveRemoteVisionServerForModality('image')?.selectedModel).toBe('picture')
    expect(getActiveRemoteVisionServerForModality('transcription')?.selectedModel).toBe('listener')
    expect(getActiveRemoteVisionServerForModality('voice')?.selectedModel).toBe('speaker')
    const image = await generateImage({ prompt: 'A blue sky', width: 512, height: 512 })
    expect(fs.readFileSync(image.path)).toEqual(generated)
    expect(image.model).toContain('picture')

    fireEvent.click(screen.getByRole('switch', { name: 'Use remote server' }))
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await screen.findByText('Local model is active.')
    expect(getActiveRemoteVisionServerForModality('image')).toBeNull()
    expect(getRemoteVisionServerSettings().servers).toHaveLength(1)

    fireEvent.click(screen.getByRole('switch', { name: 'Use remote server' }))
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await screen.findByText('Server saved and active.')
    expect(getActiveRemoteVisionServerForModality('image')?.selectedModel).toBe('picture')
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }))
    await waitFor(() => expect(getRemoteVisionServerSettings().servers).toHaveLength(0))
    expect(screen.getByText('No saved servers.')).toBeTruthy()
  })
})
