import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { CATALOG } from '@offgrid/models'
import { bridgeMediaData } from '../bridge-media-handlers'
import {
  createBridgeService,
  type BridgeReply,
  type BridgeData,
  type PairedBrowser
} from '../bridge-service'
import {
  deriveSessionKey,
  exportPublicKey,
  generateKeyPair,
  importPublicKey,
  open,
  requestAad,
  responseAad,
  seal,
  type RpcMethod
} from '../bridge-protocol'
import {
  MAX_SEALED_REQUEST_BYTES,
  MAX_SEALED_RESPONSE_BYTES,
  MAX_SPEAK_TEXT_CHARS,
  MAX_TRANSCRIBE_AUDIO_BYTES
} from '../bridge-limits'

const engine = vi.hoisted(() => ({
  speak: vi.fn(async (_text: string, _voice?: string) => ({
    dataUrl: 'data:audio/wav;base64,UklGRg=='
  })),
  transcribe: vi.fn(async (_input: { path: string }, _options: unknown) => ({ text: ' hello ' }))
}))
vi.mock('../../tts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../tts')>()),
  synthesize: engine.speak
}))
vi.mock('../../transcription/select', () => ({
  getActiveTranscription: () => ({ transcribe: engine.transcribe }),
  readTranscriptionInfo: () => ({ engine: 'whisper', modelId: null, language: 'auto' })
}))

const originalDataDir = process.env.OFFGRID_DATA_DIR
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-media-test-'))
process.env.OFFGRID_DATA_DIR = profile
const manager = await import('../../models-manager')
const { llm } = await import('../../llm')
const tts = await import('../../tts')
const init = vi.spyOn(llm, 'init').mockResolvedValue(undefined)
const family = CATALOG.find((model) => model.id === 'unsloth/Qwen3.5-0.8B-GGUF')!

beforeAll(() => {
  const dir = path.join(profile, 'models')
  fs.mkdirSync(dir, { recursive: true })
  for (const file of family.files) {
    fs.writeFileSync(
      path.join(dir, file.name),
      Buffer.concat([Buffer.from('GGUF'), Buffer.alloc(2048)])
    )
  }
})
beforeEach(() => {
  engine.speak.mockReset().mockResolvedValue({ dataUrl: 'data:audio/wav;base64,UklGRg==' })
  engine.transcribe.mockReset().mockResolvedValue({ text: ' hello ' })
  init.mockClear()
})
afterAll(() => {
  vi.restoreAllMocks()
  if (originalDataDir === undefined) delete process.env.OFFGRID_DATA_DIR
  else process.env.OFFGRID_DATA_DIR = originalDataDir
  fs.rmSync(profile, { recursive: true, force: true })
})

interface CallResult {
  status: number
  body: unknown
  envelope: unknown
  raw: unknown
}
interface MediaSetup {
  call(method: RpcMethod, params?: Record<string, unknown>): Promise<CallResult>
  pair(): Promise<BridgeReply>
}
async function setup(pro = true): Promise<MediaSetup> {
  const desktop = await generateKeyPair()
  const browser = await generateKeyPair()
  const device = 'media-browser-001'
  let saved: readonly PairedBrowser[] = []
  const data: BridgeData = {
    ...bridgeMediaData,
    features: () => ({ pro, chats: pro, tools: false, connectors: false, vault: false }),
    desktopName: () => 'Test desktop',
    listConversations: async () => [],
    putConversation: async () => {},
    deleteConversation: async () => {},
    listTools: async () => [],
    runTool: async () => null,
    latestTask: async () => null,
    stopTask: async () => false,
    setTaskRole: async () => ({ success: true }),
    vault: async () => null,
    readSettings: async () => null,
    writeSettings: async () => {}
  }
  const service = createBridgeService({
    keys: desktop,
    data,
    now: Date.now,
    newId: () => device,
    confirmPairing: async () => true,
    store: {
      list: async () => saved,
      save: async (next) => {
        saved = next
      }
    }
  })
  const key = await deriveSessionKey(
    browser.privateKey,
    (await importPublicKey(await exportPublicKey(desktop.publicKey)))!,
    device
  )
  const call = async (
    method: RpcMethod,
    params: Record<string, unknown> = {}
  ): Promise<CallResult> => {
    const id = crypto.randomUUID()
    const sealed = await seal(key, requestAad(device), { id, ts: Date.now(), method, params })
    const envelope = { v: 1, d: device, ...sealed }
    const reply = await service.rpc(envelope)
    const body =
      reply.status === 200
        ? await open(key, responseAad(device, id), reply.body as { n: string; c: string })
        : reply.body
    return { status: reply.status, body, envelope, raw: reply.body }
  }
  const pairReal = async (): Promise<BridgeReply> =>
    service.pair({
      v: 1,
      publicKey: await exportPublicKey(browser.publicKey),
      deviceName: 'Test browser'
    })
  return { call, pair: pairReal }
}

const requests = [
  ['models.inventory', {}],
  ['models.activate', { id: family.id, kind: 'text' }],
  ['audio.voices', {}],
  ['audio.transcribe', { audio: 'UklGRg==', mimeType: 'audio/webm;codecs=opus' }],
  ['audio.speak', { text: 'Hello', voice: 'af_heart' }]
] as const

describe('sealed models and audio', () => {
  it('refuses each method without pairing or Pro', async () => {
    const free = await setup(false)
    for (const [method, params] of requests) {
      expect((await free.call(method, params)).status).toBe(401)
    }
    await free.pair()
    for (const [method, params] of requests) {
      expect((await free.call(method, params)).body).toMatchObject({
        ok: false,
        error: 'pro_required'
      })
    }
    expect(init).not.toHaveBeenCalled()
    expect(engine.speak).not.toHaveBeenCalled()
    expect(engine.transcribe).not.toHaveBeenCalled()
  })

  it('activates through the real manager and reads the same core inventory', async () => {
    const s = await setup()
    await s.pair()
    expect((await s.call('models.activate', { id: family.id, kind: 'text' })).body).toMatchObject({
      ok: true,
      result: { success: true }
    })
    expect(manager.getActiveModalities().text).toBe(family.id)
    expect(init).toHaveBeenCalledOnce()
    const inventory = await s.call('models.inventory')
    expect(inventory.body).toMatchObject({
      ok: true,
      result: {
        installed: await manager.listInstalled(),
        activeIds: await manager.getActiveModelIds(),
        active: { text: family.id },
        taskRoles: { tasks: expect.any(Array), badges: expect.any(Object) }
      }
    })
    const catalog = (inventory.body as { result: { catalog: unknown[] } }).result.catalog
    expect(catalog).toContainEqual(
      expect.objectContaining({
        id: family.id,
        vision: true,
        files: family.files.map((file) => file.name)
      })
    )
    expect(JSON.stringify(inventory.raw)).not.toContain(family.id)
  })

  it('returns the core activation refusal without starting the engine', async () => {
    const s = await setup()
    await s.pair()
    const result = await s.call('models.activate', { id: 'local:missing-model', kind: 'text' })
    expect(result.body).toMatchObject({ ok: false, error: expect.any(String) })
    expect(init).not.toHaveBeenCalled()
  })

  it('lists voices, passes recordings to the core engine, and returns base64 speech', async () => {
    const s = await setup()
    await s.pair()
    expect((await s.call('audio.voices')).body).toMatchObject({
      result: { voices: await tts.listVoices() }
    })
    engine.transcribe.mockImplementationOnce(async (input, options) => {
      expect(fs.readFileSync(input.path)).toEqual(Buffer.from('RIFF'))
      expect(input.path).toMatch(/\.webm$/)
      expect(options).toEqual({})
      return { text: ' hello ' }
    })
    expect((await s.call('audio.transcribe', requests[3][1])).body).toMatchObject({
      result: { text: 'hello' }
    })
    const file = engine.transcribe.mock.calls[0]![0].path
    expect(fs.existsSync(path.dirname(file))).toBe(false)
    expect(
      (await s.call('audio.speak', { text: ' Hello ', voice: 'af_heart' })).body
    ).toMatchObject({ result: { audio: 'UklGRg==', mimeType: 'audio/wav' } })
    expect(engine.speak).toHaveBeenCalledWith('Hello', 'af_heart')
    expect((await s.call('audio.speak', { text: 'Hi' })).body).toMatchObject({ ok: true })
    expect(engine.speak).toHaveBeenLastCalledWith('Hi', undefined)
  })

  it('cleans up the private recording file on engine failure', async () => {
    const s = await setup()
    await s.pair()
    engine.transcribe.mockRejectedValueOnce(new Error('engine failed'))
    expect((await s.call('audio.transcribe', requests[3][1])).body).toMatchObject({
      error: 'engine failed'
    })
    expect(fs.existsSync(path.dirname(engine.transcribe.mock.calls[0]![0].path))).toBe(false)
  })

  it('refuses invalid fields and unknown model kinds before engine calls', async () => {
    const s = await setup()
    await s.pair()
    const cases: [RpcMethod, Record<string, unknown>][] = [
      ['models.inventory', { extra: true }],
      ['audio.voices', { extra: true }],
      ...[
        {},
        { id: family.id },
        { id: 3, kind: 'text' },
        { id: '', kind: 'text' },
        { id: family.id, kind: 'unknown' },
        { id: family.id, kind: 3 },
        { id: family.id, kind: 'text', extra: true }
      ].map((p) => ['models.activate', p] as [RpcMethod, Record<string, unknown>]),
      ...[
        {},
        { text: 3 },
        { text: '' },
        { text: ' ' },
        { text: 'x', voice: 3 },
        { text: 'x', voice: '' },
        { text: 'x', voice: 'bad voice' },
        { text: 'x', extra: 1 }
      ].map((p) => ['audio.speak', p] as [RpcMethod, Record<string, unknown>]),
      ...[
        {},
        { audio: 3, mimeType: 'audio/wav' },
        { audio: '', mimeType: 'audio/wav' },
        { audio: 'UklGRg==', mimeType: 3 },
        { audio: 'UklGRg==', mimeType: 'text/plain' },
        { audio: 'UklGRg==', mimeType: '__proto__' },
        { audio: 'UklGRg==', mimeType: 'audio/wav', extra: true },
        ...['%%%%', 'AA', 'A===', 'AB==', 'AAAA=', 'data:audio/wav;base64,AAAA', 'AA A'].map(
          (audio) => ({ audio, mimeType: 'audio/wav' })
        )
      ].map((p) => ['audio.transcribe', p] as [RpcMethod, Record<string, unknown>])
    ]
    for (const [method, params] of cases) {
      expect(
        (await s.call(method, params)).body,
        `${method} ${JSON.stringify(params)}`
      ).toMatchObject({ ok: false })
    }
    expect(engine.speak).not.toHaveBeenCalled()
    expect(engine.transcribe).not.toHaveBeenCalled()
    expect(init).not.toHaveBeenCalled()
  })

  it('refuses oversized audio and text, without truncation', async () => {
    const s = await setup()
    await s.pair()
    expect(
      (await s.call('audio.speak', { text: 'x'.repeat(MAX_SPEAK_TEXT_CHARS + 1) })).body
    ).toMatchObject({ ok: false, error: expect.stringContaining('Text too long') })
    const audio = Buffer.alloc(MAX_TRANSCRIBE_AUDIO_BYTES + 1).toString('base64')
    expect((await s.call('audio.transcribe', { audio, mimeType: 'audio/wav' })).body).toMatchObject(
      { ok: false, error: expect.stringContaining('Audio too large') }
    )
    expect(engine.speak).not.toHaveBeenCalled()
    expect(engine.transcribe).not.toHaveBeenCalled()
  })

  it('accepts the exact audio/text caps and keeps the sealed envelopes within limits', async () => {
    const s = await setup()
    await s.pair()
    const audio = Buffer.alloc(MAX_TRANSCRIBE_AUDIO_BYTES).toString('base64')
    const reply = await s.call('audio.transcribe', { audio, mimeType: 'audio/wav' })
    expect(reply.body).toMatchObject({ ok: true })
    expect(Buffer.byteLength(JSON.stringify(reply.envelope))).toBeLessThanOrEqual(
      MAX_SEALED_REQUEST_BYTES
    )
    engine.speak.mockResolvedValueOnce({
      dataUrl: `data:audio/wav;base64,${Buffer.alloc(MAX_TRANSCRIBE_AUDIO_BYTES - 128).toString('base64')}`
    })
    const speech = await s.call('audio.speak', { text: 'x'.repeat(MAX_SPEAK_TEXT_CHARS) })
    expect(speech.body).toMatchObject({ ok: true })
    expect(engine.speak.mock.calls[0]![0]).toHaveLength(MAX_SPEAK_TEXT_CHARS)
    expect(Buffer.byteLength(JSON.stringify(speech.raw))).toBeLessThanOrEqual(
      MAX_SEALED_RESPONSE_BYTES
    )
  })

  it('refuses speech that cannot fit in a sealed response', async () => {
    const s = await setup()
    await s.pair()
    engine.speak.mockResolvedValueOnce({
      dataUrl: `data:audio/wav;base64,${Buffer.alloc(MAX_TRANSCRIBE_AUDIO_BYTES + 4096).toString('base64')}`
    })
    expect((await s.call('audio.speak', { text: 'Hello' })).body).toMatchObject({
      ok: false,
      error: 'Speech audio too large for the sealed response.'
    })
  })
})
