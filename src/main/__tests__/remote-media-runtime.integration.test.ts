import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { GenerationRequest, RuntimeModel } from '@offgrid/models'
import { createRemoteMediaRuntime } from '../remote-media-runtime'

const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-remote-media-'))
const audioPath = path.join(temporaryDirectory, 'recording.wav')
const imagePath = path.join(temporaryDirectory, 'source.png')
const requests: Array<{ url: string; contentType: string; body: Buffer }> = []
let server: http.Server
let endpoint = ''

const model = (modality: RuntimeModel['modality']): RuntimeModel => ({
  id: `${modality}-model`,
  name: `${modality} model`,
  kind: modality === 'voice' ? 'voice' : modality,
  modality,
  source: 'remote',
  adapterId: `desktop.remote-${modality}`,
  serverId: 'loopback',
  capabilities: {},
  installed: true,
  ready: true,
  loaded: false
})

function request(operation: NonNullable<GenerationRequest['operation']>): GenerationRequest {
  return { operation, allowFallback: false }
}

beforeAll(async () => {
  fs.writeFileSync(audioPath, Buffer.from('RIFF-test-audio'))
  fs.writeFileSync(imagePath, Buffer.from('test-image'))
  server = http.createServer((incoming, outgoing) => {
    const chunks: Buffer[] = []
    incoming.on('data', (chunk: Buffer) => chunks.push(chunk))
    incoming.on('end', () => {
      requests.push({
        url: incoming.url ?? '',
        contentType: incoming.headers['content-type'] ?? '',
        body: Buffer.concat(chunks)
      })
      if (incoming.url === '/v1/images/generations' || incoming.url === '/v1/images/edits') {
        outgoing.writeHead(200, { 'Content-Type': 'application/json' })
        outgoing.end(JSON.stringify({ data: [{ b64_json: 'aW1hZ2U=' }] }))
        return
      }
      if (incoming.url === '/v1/audio/transcriptions') {
        outgoing.writeHead(200, { 'Content-Type': 'application/json' })
        outgoing.end(JSON.stringify({ text: ' hello ', language: 'en' }))
        return
      }
      if (incoming.url === '/v1/audio/speech') {
        outgoing.writeHead(200, { 'Content-Type': 'audio/mpeg' })
        outgoing.end(Buffer.from('voice'))
        return
      }
      if (incoming.url === '/v1/embeddings') {
        outgoing.writeHead(200, { 'Content-Type': 'application/json' })
        outgoing.end(JSON.stringify({ data: [{ embedding: [0.1, 0.2] }] }))
        return
      }
      outgoing.writeHead(404).end()
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`
})

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()))
  })
  fs.rmSync(temporaryDirectory, { recursive: true, force: true })
})

describe('Desktop remote media transport', () => {
  it('executes image, image edit, transcription, and voice on one remote route', async () => {
    const runtime = createRemoteMediaRuntime(() => ({ endpoint, apiKey: '' }))

    await expect(
      runtime.image(
        model('image'),
        request({ type: 'image', prompt: 'A forest', width: 768, height: 512 })
      )
    ).resolves.toEqual({ base64: 'aW1hZ2U=' })
    await expect(
      runtime.image(
        model('image'),
        request({
          type: 'image',
          prompt: 'Edit the forest',
          sourceImage: { type: 'image', uri: imagePath },
          strength: 0.4
        })
      )
    ).resolves.toEqual({ base64: 'aW1hZ2U=' })
    await expect(
      runtime.transcription(
        model('transcription'),
        request({
          type: 'transcription',
          audio: { type: 'audio', uri: audioPath, mimeType: 'audio/wav' },
          language: 'en'
        })
      )
    ).resolves.toEqual({ text: 'hello', language: 'en' })
    await expect(
      runtime.voice(model('voice'), request({ type: 'voice', text: 'Hello', voice: 'alloy' }))
    ).resolves.toEqual({ data: Buffer.from('voice').toString('base64'), mimeType: 'audio/mpeg' })
    await expect(
      runtime.embedding(model('embedding'), request({ type: 'embedding', inputs: ['Hello'] }))
    ).resolves.toEqual([[0.1, 0.2]])

    expect(requests.map(({ url }) => url)).toEqual([
      '/v1/images/generations',
      '/v1/images/edits',
      '/v1/audio/transcriptions',
      '/v1/audio/speech',
      '/v1/embeddings'
    ])
    expect(requests[0]?.body.toString()).toContain('"size":"768x512"')
    expect(requests[1]?.contentType).toContain('multipart/form-data')
    expect(requests[1]?.body.toString()).toContain('name="strength"')
    expect(requests[2]?.body.toString()).toContain('name="language"')
    expect(requests[3]?.body.toString()).toContain('"voice":"alloy"')
  })

  it('cancels an active remote media response', async () => {
    const controller = new AbortController()
    const runtime = createRemoteMediaRuntime(
      () => ({ endpoint, apiKey: '' }),
      async () => {
        await new Promise<void>((_resolve, reject) => {
          controller.signal.addEventListener('abort', () => reject(controller.signal.reason), {
            once: true
          })
        })
        throw new Error('unreachable')
      }
    )
    const pending = runtime.voice(model('voice'), {
      ...request({ type: 'voice', text: 'Stop' }),
      signal: controller.signal
    })
    controller.abort(new Error('cancelled by user'))
    await expect(pending).rejects.toThrow('cancelled by user')
  })
})
