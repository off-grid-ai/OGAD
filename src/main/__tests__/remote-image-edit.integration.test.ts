import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createServer, type Server } from 'node:http'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { generateRemoteImage } from '../remote-media-runtime'
import { parseMultipart } from '../model-server/multipart'

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=',
  'base64'
)
let server: Server
let directory: string
let endpoint: string

beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ogad-image-edit-'))
  await fs.writeFile(path.join(directory, 'source.png'), png)
  // External OpenAI-compatible provider boundary. Accept only its documented wire contract.
  server = createServer(async (request, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    const payload = Buffer.concat(chunks)
    const edit = request.url === '/v1/images/edits'
    const form = edit ? parseMultipart(payload, request.headers['content-type'] ?? '') : null
    const fields = form?.fields ?? JSON.parse(payload.toString())
    const valid =
      request.method === 'POST' &&
      request.headers.authorization === 'Bearer test-key' &&
      (edit || request.url === '/v1/images/generations') &&
      fields.model === 'qwen_image_2.1-Q4_K.gguf' &&
      fields.prompt === 'Make it blue' &&
      fields.size === '64x64' &&
      Number(fields.steps) === 5 &&
      Number(fields.cfg_scale) === 1 &&
      Number(fields.seed) === 42 &&
      String(fields.allow_unsafe_memory_override) === 'false' &&
      (!edit || form?.files.image?.data.equals(png))
    if (!valid) {
      response.writeHead(400, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ error: { message: 'Invalid image request.' } }))
      return
    }
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify({ data: [{ b64_json: png.toString('base64') }] }))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing server port')
  endpoint = `http://127.0.0.1:${address.port}/v1`
})

afterEach(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve()))
  )
  await fs.rm(directory, { recursive: true, force: true })
})

it.each([true, false])('supports image requests with source image=%s', async (edit) => {
  const result = await generateRemoteImage(
    {
      id: 'test',
      name: 'Test server',
      provider: 'ogad',
      endpoint,
      model: 'qwen_image_2.1-Q4_K.gguf',
      selectedModel: 'qwen_image_2.1-Q4_K.gguf',
      apiKey: 'test-key',
      screenFramesAllowed: false
    },
    'Make it blue',
    64,
    64,
    false,
    undefined,
    edit ? path.join(directory, 'source.png') : undefined,
    { steps: 5, cfgScale: 1, seed: 42 }
  )
  expect(result.mime).toBe('image/png')
  expect(result.bytes).toEqual(png)
})
