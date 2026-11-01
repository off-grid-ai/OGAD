import fs from 'node:fs'
import { createServer, type Server } from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'

// Settings > Voice and the comic reader both ask main for `tts:voices`. A remote speech model
// chosen on an OpenAI-compatible ("custom") server must answer with that server's speakers.
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-remote-voices-'))
const previousDirectory = process.env.OFFGRID_DATA_DIR
process.env.OFFGRID_DATA_DIR = directory
const handlers = vi.hoisted(() => new Map<string, (...args: unknown[]) => unknown>())
vi.mock('electron', () => ({
  app: { getPath: () => directory, isPackaged: false, getAppPath: () => process.cwd() },
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) =>
      handlers.set(channel, handler)
  },
  safeStorage: { isEncryptionAvailable: () => false }
}))
import { getDB } from '../database'
import { listVoices } from '../tts'
import { setupTtsIpc } from '../tts-ipc'
import {
  activateRemoteVisionMediaModel,
  setRemoteVisionServerSettings
} from '../vision/remote-vision-server'

let gateway: Server | undefined
afterEach(async () => {
  if (gateway) await new Promise<void>((resolve) => gateway!.close(() => resolve()))
  gateway = undefined
})
afterAll(() => {
  getDB().close()
  if (previousDirectory === undefined) delete process.env.OFFGRID_DATA_DIR
  else process.env.OFFGRID_DATA_DIR = previousDirectory
  fs.rmSync(directory, { recursive: true, force: true })
})

/** The speech entry a packaged Off Grid gateway lists at GET /v1/models. */
const GATEWAY_MODELS = {
  object: 'list',
  data: [
    {
      id: 'kokoro-82m-v1.0.onnx',
      object: 'model',
      owned_by: 'off-grid',
      kind: 'speech',
      voices: ['af_heart', 'df_anna', 'hf_alpha'],
      supported_voices: ['af_heart', 'df_anna', 'hf_alpha'],
      architecture: { input_modalities: ['text'], output_modalities: ['speech'] }
    }
  ]
}

async function startGateway(): Promise<string> {
  gateway = createServer((req, res) => {
    if (req.method === 'GET' && req.url?.startsWith('/v1/models')) {
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify(GATEWAY_MODELS))
      return
    }
    res.writeHead(404)
    res.end()
  })
  await new Promise<void>((resolve) => gateway!.listen(0, '127.0.0.1', resolve))
  const address = gateway.address()
  if (!address || typeof address === 'string') throw Error('Missing gateway port')
  return `http://127.0.0.1:${address.port}/v1`
}

describe('remote speech speakers through the tts:voices contract', () => {
  it('lists the Kokoro speakers and languages of a speech model on a custom server', async () => {
    const endpoint = await startGateway()
    const serverId = 'gpu-pod'
    setRemoteVisionServerSettings({
      serverId,
      name: 'GPU pod',
      provider: 'custom',
      endpoint,
      model: '',
      mediaModels: { voice: 'kokoro-82m-v1.0.onnx' }
    })
    expect(activateRemoteVisionMediaModel(serverId, 'voice', 'kokoro-82m-v1.0.onnx')).toBe(true)
    setupTtsIpc()

    const voices = await handlers.get('tts:voices')!()

    expect(voices).toEqual([
      { id: 'af_heart', label: 'Heart', language: 'en-US', languageLabel: 'English (US)' },
      { id: 'df_anna', label: 'Anna', language: 'de', languageLabel: 'German' },
      { id: 'hf_alpha', label: 'Alpha', language: 'hi', languageLabel: 'Hindi' }
    ])
  })
  it("lists this machine's own voices on request, with a remote speech model chosen", async () => {
    const endpoint = await startGateway()
    setRemoteVisionServerSettings({
      serverId: 'gpu-pod',
      name: 'GPU pod',
      provider: 'custom',
      endpoint,
      model: '',
      mediaModels: { voice: 'kokoro-82m-v1.0.onnx' }
    })
    expect(activateRemoteVisionMediaModel('gpu-pod', 'voice', 'kokoro-82m-v1.0.onnx')).toBe(true)

    // Local synthesis (the wake word trainer) can only speak ids this machine knows.
    const local = await listVoices(undefined, { local: true })

    expect(await listVoices()).toEqual(['af_heart', 'df_anna', 'hf_alpha'])
    expect(local).toContain('af_heart')
    expect(local).toContain('am_adam')
  })
})
