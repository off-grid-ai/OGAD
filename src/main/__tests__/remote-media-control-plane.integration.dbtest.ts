import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import type { OffGridApplication } from '@offgrid/application'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-remote-control-plane-'))
process.env.OFFGRID_DATA_DIR = profile

vi.mock('electron', () => ({
  app: { getPath: () => profile, isPackaged: false, getAppPath: () => process.cwd() },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString()
  }
}))

const requests: string[] = []
let server: http.Server
let endpoint = ''
let serverId = ''
let application: OffGridApplication
const audioPath = path.join(profile, 'sample.wav')

beforeAll(async () => {
  const [{ createOffGridApplication }, { desktopModelWorkspacePorts }, applicationAccess] =
    await Promise.all([
      import('@offgrid/application'),
      import('../model-services'),
      import('../composition/application-access')
    ])
  application = createOffGridApplication({ models: desktopModelWorkspacePorts })
  applicationAccess.registerDesktopApplication(application)
  await application.start()
  fs.writeFileSync(audioPath, Buffer.from('RIFF-test'))
  server = http.createServer((request, response) => {
    requests.push(request.url ?? '')
    if (request.method === 'GET' && request.url === '/v1/models') {
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(
        JSON.stringify({
          data: [
            {
              id: 'remote-chat',
              name: 'Remote Chat',
              kind: 'vision',
              capabilities: ['vision', 'tools']
            },
            { id: 'remote-image', name: 'Remote Image', kind: 'image' },
            { id: 'remote-stt', name: 'Remote STT', kind: 'transcription' },
            { id: 'remote-voice', name: 'Remote Voice', kind: 'speech' },
            { id: 'remote-embedding', name: 'Remote Embedding', kind: 'embedding' }
          ]
        })
      )
      return
    }
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => {
      if (request.url === '/v1/images/generations') {
        response.writeHead(200, { 'Content-Type': 'application/json' })
        response.end(JSON.stringify({ data: [{ b64_json: 'aW1hZ2U=' }] }))
        return
      }
      if (request.url === '/v1/audio/transcriptions') {
        response.writeHead(200, { 'Content-Type': 'application/json' })
        response.end(JSON.stringify({ text: 'remote transcript' }))
        return
      }
      if (request.url === '/v1/audio/speech') {
        response.writeHead(200, { 'Content-Type': 'audio/mpeg' })
        response.end(Buffer.from('remote voice'))
        return
      }
      if (request.url === '/v1/embeddings') {
        response.writeHead(200, { 'Content-Type': 'application/json' })
        response.end(JSON.stringify({ data: [{ index: 0, embedding: [0.1, 0.2] }] }))
        return
      }
      response.writeHead(404).end()
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(async () => {
  const { removeRemoteVisionServer } = await import('../vision/remote-vision-server')
  if (serverId) await removeRemoteVisionServer(serverId)
  await application.stop()
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()))
  })
  fs.rmSync(profile, { recursive: true, force: true })
})

describe('Desktop remote media control plane', () => {
  it('discovers, persists, selects, restarts, and executes every advertised modality', async () => {
    const remote = await import('../vision/remote-vision-server')
    const discovery = await remote.testRemoteVisionServer({
      provider: 'custom',
      endpoint,
      model: ''
    })
    expect(discovery.ok).toBe(true)
    expect(discovery.models?.map((model) => [model.name, model.modality])).toEqual([
      ['Remote Chat', 'text'],
      ['Remote Image', 'image'],
      ['Remote STT', 'transcription'],
      ['Remote Voice', 'voice'],
      ['Remote Embedding', 'embedding']
    ])

    const saved = await remote.setRemoteVisionServerSettings({
      provider: 'custom',
      endpoint,
      model: discovery.selections?.text ?? '',
      name: 'Home model server',
      catalog: discovery.catalog,
      selections: discovery.selections
    })
    serverId = saved.servers[0]!.id
    expect(saved.servers[0]).toMatchObject({
      name: 'Home model server',
      selections: {
        text: 'remote-chat',
        image: 'remote-image',
        transcription: 'remote-stt',
        voice: 'remote-voice',
        embedding: 'remote-embedding'
      }
    })
    expect(remote.getRemoteVisionServerSettings().servers[0]?.catalog?.image?.[0]?.name).toBe(
      'Remote Image'
    )

    await application.models.refresh()
    const inventory = application.models.snapshot().inventory
    expect(
      inventory
        .filter((model) => model.serverId === serverId)
        .map((model) => [model.name, model.modality, model.adapterId])
    ).toEqual(
      expect.arrayContaining([
        ['Remote Chat', 'text', 'desktop.remote-chat'],
        ['Remote Image', 'image', 'desktop.remote-image'],
        ['Remote STT', 'transcription', 'desktop.remote-transcription'],
        ['Remote Voice', 'voice', 'desktop.remote-voice'],
        ['Remote Embedding', 'embedding', 'desktop.remote-embedding']
      ])
    )
    expect(application.models.snapshot().active.image?.model?.name).toBe('Remote Image')
    expect(application.models.snapshot().active.voice?.model?.name).toBe('Remote Voice')

    const { generateDesktopOperation } = await import('../desktop-generation')
    await expect(
      generateDesktopOperation({ type: 'image', prompt: 'forest' })
    ).resolves.toMatchObject({
      output: { type: 'image', images: [{ data: 'aW1hZ2U=' }] }
    })
    await expect(
      generateDesktopOperation({
        type: 'transcription',
        audio: { type: 'audio', uri: audioPath }
      })
    ).resolves.toMatchObject({ output: { type: 'transcription', text: 'remote transcript' } })
    await expect(generateDesktopOperation({ type: 'voice', text: 'hello' })).resolves.toMatchObject(
      {
        output: { type: 'voice', audio: { mimeType: 'audio/mpeg' } }
      }
    )
    await expect(
      generateDesktopOperation({ type: 'embedding', inputs: ['hello'] })
    ).resolves.toMatchObject({
      output: { type: 'embedding', vectors: [[0.1, 0.2]] }
    })
    expect(requests).toEqual(
      expect.arrayContaining([
        '/v1/images/generations',
        '/v1/audio/transcriptions',
        '/v1/audio/speech',
        '/v1/embeddings'
      ])
    )
  })

  it('does not store or send credentials over public HTTP', async () => {
    const remote = await import('../vision/remote-vision-server')
    await expect(
      remote.testRemoteVisionServer({
        provider: 'custom',
        endpoint,
        model: 'chat',
        apiKey: 'secret'
      })
    ).resolves.toMatchObject({ ok: false, error: expect.stringMatching(/HTTPS/) })
  })
})
