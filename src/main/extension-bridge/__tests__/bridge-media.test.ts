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

// The boundaries: the speech library (kokoro-js) under the real voice worker, the native
// executables (ffmpeg and whisper-cli for transcription, llama-server for chat), Electron's
// helper-process launcher, and the disk where a built app keeps the worker beside tts-onnx.
const speech = vi.hoisted(() => ({
  bytesPerChar: 8,
  spoken: [] as Array<{ text: string; voice: string }>
}))
vi.mock('kokoro-js', () => ({
  KokoroTTS: {
    from_pretrained: async () => ({
      generate: async (text: string, options: { voice: string }) => {
        speech.spoken.push({ text, voice: options.voice })
        // An audible tone: the worker refuses silent audio, as it should.
        const samples = Math.ceil((text.length * speech.bytesPerChar) / 2)
        return {
          data: Float32Array.from({ length: samples }, (_, i) => Math.sin(i / 8) * 0.3),
          sampling_rate: 24000
        }
      }
    })
  }
}))
vi.mock('node:fs', async (original) => {
  const actual = await original<typeof import('node:fs')>()
  const existsSync = (file: import('node:fs').PathLike): boolean =>
    String(file).endsWith('tts-onnx-worker.js') || actual.existsSync(file)
  return { ...actual, existsSync, default: { ...actual, existsSync } }
})
// Electron's utility process, running the real voice worker in this process: messages cross the
// same parentPort contract the helper process uses.
vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events')
  return {
    app: {
      getPath: () => process.env.OFFGRID_DATA_DIR,
      isPackaged: false,
      getAppPath: () => process.cwd()
    },
    safeStorage: { isEncryptionAvailable: () => false },
    BrowserWindow: { getAllWindows: () => [] },
    utilityProcess: {
      fork: () => {
        const child = new EventEmitter() as InstanceType<typeof EventEmitter> & {
          postMessage(message: unknown): void
          kill(): boolean
        }
        const listeners: Array<(event: { data: unknown }) => void> = []
        Object.defineProperty(process, 'parentPort', {
          configurable: true,
          value: {
            on: (_event: string, listener: (event: { data: unknown }) => void) =>
              listeners.push(listener),
            postMessage: (message: unknown) => child.emit('message', message)
          }
        })
        const ready = import('../../tts-onnx-worker')
        child.postMessage = (message) =>
          void ready.then(() => listeners.forEach((listener) => listener({ data: message })))
        child.kill = () => {
          child.emit('exit', 0)
          return true
        }
        return child
      }
    }
  }
})

const originalDataDir = process.env.OFFGRID_DATA_DIR
const originalBinDir = process.env.OFFGRID_BIN_DIR
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-media-test-'))
process.env.OFFGRID_DATA_DIR = profile
const bin = path.join(profile, 'bin')
process.env.OFFGRID_BIN_DIR = bin
const manager = await import('../../models-manager')
const { llm } = await import('../../llm')
const tts = await import('../../tts')
const { installFakeLlamaEngine, unusedPort, processAlive } =
  await import('../../__tests__/harness/fake-llama-engine')
const family = CATALOG.find((model) => model.id === 'unsloth/Qwen3.5-0.8B-GGUF')!
const chatEngine = installFakeLlamaEngine(bin)

// ffmpeg logs each recording it decodes (path and bytes) and copies it out; whisper-cli hears
// " hello ", or fails while `whisper-fail` exists.
const FFMPEG = `#!/usr/bin/env node
const fs = require('node:fs')
const path = require('node:path')
const input = process.argv[process.argv.indexOf('-i') + 1]
fs.appendFileSync(path.join(__dirname, 'decoded.log'), JSON.stringify({ input, bytes: fs.readFileSync(input).toString('base64') }) + '\\n')
fs.copyFileSync(input, process.argv.at(-1))
`
const WHISPER = `#!/usr/bin/env node
const fs = require('node:fs')
const path = require('node:path')
if (fs.existsSync(path.join(path.dirname(__dirname), 'whisper-fail'))) { process.stderr.write('engine failed'); process.exit(1) }
process.stdout.write(' hello ')
`
const decoded = (): Array<{ input: string; bytes: string }> => {
  try {
    return fs
      .readFileSync(path.join(bin, 'decoded.log'), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line))
  } catch {
    return []
  }
}

beforeAll(async () => {
  const dir = path.join(profile, 'models')
  fs.mkdirSync(dir, { recursive: true })
  for (const file of family.files) {
    fs.writeFileSync(
      path.join(dir, file.name),
      Buffer.concat([Buffer.from('GGUF'), Buffer.alloc(2048)])
    )
  }
  fs.writeFileSync(path.join(dir, 'ggml-base.bin'), Buffer.alloc(1024, 1))
  fs.writeFileSync(path.join(bin, 'ffmpeg'), FFMPEG, { mode: 0o755 })
  fs.mkdirSync(path.join(bin, 'whisper'), { recursive: true })
  fs.writeFileSync(path.join(bin, 'whisper', 'whisper-cli'), WHISPER, { mode: 0o755 })
  ;(llm as unknown as { port: number }).port = await unusedPort()
})
beforeEach(() => {
  speech.bytesPerChar = 8
  speech.spoken.length = 0
  fs.rmSync(path.join(bin, 'decoded.log'), { force: true })
  fs.rmSync(path.join(bin, 'whisper-fail'), { force: true })
})
afterAll(() => {
  llm.stop()
  for (const { pid } of chatEngine.launches()) if (processAlive(pid)) process.kill(pid, 'SIGKILL')
  if (originalDataDir === undefined) delete process.env.OFFGRID_DATA_DIR
  else process.env.OFFGRID_DATA_DIR = originalDataDir
  if (originalBinDir === undefined) delete process.env.OFFGRID_BIN_DIR
  else process.env.OFFGRID_BIN_DIR = originalBinDir
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
    expect(chatEngine.launches()).toHaveLength(0)
    expect(speech.spoken).toEqual([])
    expect(decoded()).toEqual([])
  })

  it('activates through the real manager and reads the same core inventory', async () => {
    const s = await setup()
    await s.pair()
    expect((await s.call('models.activate', { id: family.id, kind: 'text' })).body).toMatchObject({
      ok: true,
      result: { success: true }
    })
    expect(manager.getActiveModalities().text).toBe(family.id)
    // The chat engine loads the activated model.
    await vi.waitFor(() => expect(chatEngine.launches()).toHaveLength(1))
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
    const launched = chatEngine.launches().length
    const result = await s.call('models.activate', { id: 'local:missing-model', kind: 'text' })
    expect(result.body).toMatchObject({ ok: false, error: expect.any(String) })
    expect(chatEngine.launches()).toHaveLength(launched)
  })

  it('lists voices, passes recordings to the core engine, and returns base64 speech', async () => {
    const s = await setup()
    await s.pair()
    expect((await s.call('audio.voices')).body).toMatchObject({
      result: { voices: await tts.listVoices() }
    })
    expect((await s.call('audio.transcribe', requests[3][1])).body).toMatchObject({
      result: { text: 'hello' }
    })
    // The recording reached the engine as a private .webm file with its bytes, then was removed.
    const [recording] = decoded()
    expect(Buffer.from(recording!.bytes, 'base64')).toEqual(Buffer.from('RIFF'))
    expect(recording!.input).toMatch(/\.webm$/)
    expect(fs.existsSync(path.dirname(recording!.input))).toBe(false)
    const spoken = (await s.call('audio.speak', { text: ' Hello ', voice: 'af_heart' })).body as {
      result: { audio: string; mimeType: string }
    }
    expect(spoken.result.mimeType).toBe('audio/wav')
    expect(Buffer.from(spoken.result.audio, 'base64').subarray(0, 4).toString()).toBe('RIFF')
    expect(speech.spoken).toEqual([{ text: 'Hello', voice: 'af_heart' }])
    expect((await s.call('audio.speak', { text: 'Hi' })).body).toMatchObject({ ok: true })
    // No voice asked for: the default voice speaks.
    expect(speech.spoken.at(-1)).toEqual({ text: 'Hi', voice: 'af_heart' })
  })

  it('cleans up the private recording file on engine failure', async () => {
    const s = await setup()
    await s.pair()
    fs.writeFileSync(path.join(bin, 'whisper-fail'), '')
    expect((await s.call('audio.transcribe', requests[3][1])).body).toMatchObject({
      error: expect.stringContaining('engine failed')
    })
    expect(fs.existsSync(path.dirname(decoded()[0]!.input))).toBe(false)
  })

  it('refuses invalid fields and unknown model kinds before engine calls', async () => {
    const s = await setup()
    await s.pair()
    const launched = chatEngine.launches().length
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
    expect(speech.spoken).toEqual([])
    expect(decoded()).toEqual([])
    expect(chatEngine.launches()).toHaveLength(launched)
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
    expect(speech.spoken).toEqual([])
    expect(decoded()).toEqual([])
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
    // Speech just under the audio cap (a WAV header plus 16-bit samples).
    speech.bytesPerChar = Math.floor((MAX_TRANSCRIBE_AUDIO_BYTES - 128 - 44) / MAX_SPEAK_TEXT_CHARS)
    const reply2 = await s.call('audio.speak', { text: 'x'.repeat(MAX_SPEAK_TEXT_CHARS) })
    expect(reply2.body).toMatchObject({ ok: true })
    // Every character was spoken: none was cut off.
    expect(
      speech.spoken
        .map(({ text }) => text)
        .join('')
        .replace(/\s/g, '')
    ).toHaveLength(MAX_SPEAK_TEXT_CHARS)
    expect(Buffer.byteLength(JSON.stringify(reply2.raw))).toBeLessThanOrEqual(
      MAX_SEALED_RESPONSE_BYTES
    )
  })

  it('refuses speech that cannot fit in a sealed response', async () => {
    const s = await setup()
    await s.pair()
    // Five characters of speech that come back larger than a sealed response can carry.
    speech.bytesPerChar = Math.ceil((MAX_TRANSCRIBE_AUDIO_BYTES + 4096) / 5)
    expect((await s.call('audio.speak', { text: 'Hello' })).body).toMatchObject({
      ok: false,
      error: 'Speech audio too large for the sealed response.'
    })
  })
})
