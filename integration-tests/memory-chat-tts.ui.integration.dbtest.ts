// @vitest-environment jsdom
/**
 * Release checklist #105 through the real rendered assistant action, TTS IPC handler,
 * persisted voice setting, synthesis service, subprocess protocol, and WAV validation.
 * The fake subprocess replaces only the heavyweight Kokoro/ONNX worker; Audio replaces
 * Chromium's media boundary. All Off Grid code between those boundaries stays production.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Blob as NodeBlob } from 'node:buffer'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import '../src/renderer/src/__tests__/browser-boundaries.setup'
import {
  ChatBoundary,
  installBoundary,
  renderChat
} from '../src/renderer/src/components/__tests__/harness/chat-boundary'
import {
  startFakeLlamaServer,
  type FakeLlamaServer
} from '../src/main/__tests__/harness/fake-llama-server'

type IpcEvent = { sender: { send: (channel: string, payload: unknown) => void } }
type IpcHandler = (event: IpcEvent, ...args: unknown[]) => unknown
const handlers = new Map<string, IpcHandler>()
const listeners = new Map<string, (event: IpcEvent, ...args: unknown[]) => unknown>()
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-memory-chat-tts-'))
const dataDir = path.join(root, 'data')
const resourceDir = path.join(root, 'resources')
const binDir = path.join(root, 'bin')
const failureMarker = path.join(root, 'fail-next-synthesis')
const inputRecord = path.join(root, 'worker-input.txt')
const voiceRecord = path.join(root, 'worker-voice.txt')
const originalDataDir = process.env.OFFGRID_DATA_DIR
const originalResourceDir = process.env.OFFGRID_RESOURCE_DIR
const originalBinDir = process.env.OFFGRID_BIN_DIR
const originalFailureMarker = process.env.OFFGRID_TTS_TEST_FAILURE_MARKER
const originalInputRecord = process.env.OFFGRID_TTS_TEST_INPUT_RECORD
const originalVoiceRecord = process.env.OFFGRID_TTS_TEST_VOICE_RECORD

process.env.OFFGRID_DATA_DIR = dataDir
process.env.OFFGRID_RESOURCE_DIR = resourceDir
process.env.OFFGRID_BIN_DIR = binDir
process.env.OFFGRID_TTS_TEST_FAILURE_MARKER = failureMarker
process.env.OFFGRID_TTS_TEST_INPUT_RECORD = inputRecord
process.env.OFFGRID_TTS_TEST_VOICE_RECORD = voiceRecord

vi.mock('electron', () => ({
  app: {
    getPath: () => dataDir,
    isPackaged: false,
    getAppPath: () => process.cwd()
  },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString()
  },
  ipcMain: {
    handle: (channel: string, handler: IpcHandler) => handlers.set(channel, handler),
    on: (channel: string, listener: (event: IpcEvent, ...args: unknown[]) => unknown) =>
      listeners.set(channel, listener)
  },
  BrowserWindow: { fromWebContents: () => null },
  clipboard: { readText: () => '', writeText: () => undefined },
  systemPreferences: {
    isTrustedAccessibilityClient: () => true,
    getMediaAccessStatus: () => 'granted'
  },
  shell: { openExternal: async () => undefined },
  desktopCapturer: { getSources: async () => [] }
}))

const database = await import('../src/main/database')
const { getDB, saveSetting } = database
const runtimeEnv = await import('../src/main/runtime-env')
runtimeEnv.configureRuntime({ dataDir, binRoots: [binDir], resourceDirs: [resourceDir] })
const { setupIPC } = await import('../src/main/ipc')

interface AudioBoundary {
  src: string
  play: ReturnType<typeof vi.fn>
  pause: ReturnType<typeof vi.fn>
}

const audios: AudioBoundary[] = []
let fakeLlama: FakeLlamaServer

class RecorderBoundary {
  static instances: RecorderBoundary[] = []
  state: RecordingState = 'inactive'
  ondataavailable: ((event: BlobEvent) => void) | null = null
  onstop: (() => void) | null = null

  constructor(_stream: MediaStream) {
    RecorderBoundary.instances.push(this)
  }

  start(): void {
    this.state = 'recording'
  }

  stop(): void {
    this.state = 'inactive'
    this.ondataavailable?.({
      data: new NodeBlob([new Uint8Array([82, 73, 70, 70, 1, 2, 3])])
    } as unknown as BlobEvent)
    this.onstop?.()
  }
}

function executable(relativePath: string, source: string): void {
  const target = path.join(binDir, relativePath)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, source, { mode: 0o755 })
}

async function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  const handler = handlers.get(channel)
  if (!handler) throw new Error(`IPC handler not registered: ${channel}`)
  return (await handler({ sender: { send: () => undefined } }, ...args)) as T
}

function installProductionVoiceBridge(boundary: ChatBoundary): void {
  Object.assign(boundary.api, {
    getRagConversations: (projectId?: string | null) => invoke('rag:get-conversations', projectId),
    getRagConversation: (id: string) => invoke('rag:get-conversation', id),
    getRagMessages: (id: string) => invoke('rag:get-messages', id),
    createRagConversation: (id: string, title?: string, projectId?: string | null) =>
      invoke('rag:create-conversation', id, title, projectId),
    addRagMessage: (id: string, role: 'user' | 'assistant', content: string, context?: unknown) =>
      invoke('rag:add-message', id, role, content, context),
    truncateRagMessages: (id: string, keepCount: number) =>
      invoke('rag:truncate-messages', id, keepCount),
    getSettings: () => invoke('settings:get'),
    saveSetting: (key: string, value: unknown) => invoke('settings:save', key, value),
    transcribeAudio: (audio: ArrayBuffer | Uint8Array, ext?: string) =>
      invoke('voice:transcribe', audio, ext),
    ragChat: (...args: unknown[]) => invoke('rag:chat', ...args),
    speak: (text: string, voice?: string) => invoke('tts:speak', text, voice)
  })
  installBoundary(boundary)
}

function setEnv(name: string, original: string | undefined): void {
  if (original === undefined) delete process.env[name]
  else process.env[name] = original
}

function installRealSpeechBridge(boundary: ChatBoundary): void {
  const handler = handlers.get('tts:speak')
  if (!handler) throw new Error('TTS IPC handler was not registered')
  ;(
    boundary.api as unknown as {
      speak: (text: string, voice?: string) => Promise<{ dataUrl: string }>
    }
  ).speak = (text, voice) => handler(undefined, text, voice) as Promise<{ dataUrl: string }>
  installBoundary(boundary)
}

beforeAll(async () => {
  fs.mkdirSync(dataDir, { recursive: true })
  fs.mkdirSync(resourceDir, { recursive: true })
  fs.mkdirSync(path.join(dataDir, 'models'), { recursive: true })
  fs.writeFileSync(path.join(dataDir, 'models', 'ggml-base.bin'), 'synthetic whisper model')
  executable('ffmpeg', ['#!/bin/sh', 'for last; do :; done', 'printf RIFF > "$last"'].join('\n'))
  executable('whisper/whisper-cli', '#!/bin/sh\nprintf "Schedule the stable release review\\n"')
  fs.writeFileSync(
    path.join(resourceDir, 'tts-worker.mjs'),
    [
      "import fs from 'node:fs'",
      'const [, , command, output, voice] = process.argv',
      "let input = ''",
      "process.stdin.setEncoding('utf8')",
      "process.stdin.on('data', chunk => { input += chunk })",
      "process.stdin.on('end', () => {",
      "  if (fs.existsSync(process.env.OFFGRID_TTS_TEST_FAILURE_MARKER || '')) {",
      '    fs.rmSync(process.env.OFFGRID_TTS_TEST_FAILURE_MARKER, { force: true })',
      "    process.stderr.write('local speech model is unavailable')",
      '    return',
      '  }',
      "  if (command !== 'speak' || !output) return",
      '  fs.writeFileSync(process.env.OFFGRID_TTS_TEST_INPUT_RECORD, input)',
      "  fs.writeFileSync(process.env.OFFGRID_TTS_TEST_VOICE_RECORD, voice || '')",
      "  fs.writeFileSync(output, Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(60, 1)]))",
      '})'
    ].join('\n'),
    { mode: 0o755 }
  )
  setupIPC()
  saveSetting('ttsVoice', 'af_bella')
  fakeLlama = await startFakeLlamaServer()
  const { llm } = await import('../src/main/llm')
  const service = llm as unknown as { port: number; initialized: boolean; paused: boolean }
  service.port = fakeLlama.port
  service.initialized = true
  service.paused = false
})

beforeEach(() => {
  audios.length = 0
  RecorderBoundary.instances = []
  fs.rmSync(failureMarker, { force: true })
  ;(Element.prototype as unknown as { scrollIntoView: () => void }).scrollIntoView = () => {}
  globalThis.requestAnimationFrame = (callback: FrameRequestCallback): number => {
    callback(0)
    return 1
  }
  vi.stubGlobal(
    'Audio',
    class implements AudioBoundary {
      error = null
      onended: (() => void) | null = null
      onerror: (() => void) | null = null
      play = vi.fn(async () => undefined)
      pause = vi.fn()

      constructor(readonly src: string) {
        audios.push(this)
      }
    }
  )
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

afterAll(async () => {
  const { llm } = await import('../src/main/llm')
  llm.stop()
  await fakeLlama.close()
  getDB().close()
  setEnv('OFFGRID_DATA_DIR', originalDataDir)
  setEnv('OFFGRID_RESOURCE_DIR', originalResourceDir)
  setEnv('OFFGRID_BIN_DIR', originalBinDir)
  setEnv('OFFGRID_TTS_TEST_FAILURE_MARKER', originalFailureMarker)
  setEnv('OFFGRID_TTS_TEST_INPUT_RECORD', originalInputRecord)
  setEnv('OFFGRID_TTS_TEST_VOICE_RECORD', originalVoiceRecord)
  runtimeEnv.configureRuntime({ dataDir: undefined, binRoots: undefined, resourceDirs: undefined })
  fs.rmSync(root, { recursive: true, force: true })
})

/**
 * The reply as the TRANSCRIPT shows it, not the history rail's preview of it.
 *
 * The chat list shows each conversation's last message, so a reply is legitimately on screen twice and a
 * bare getByText throws "found multiple elements" for a UI that is behaving correctly. The rail is the
 * <aside> (role complementary); anything outside it is transcript.
 */
const inTranscript = (text: string): HTMLElement => {
  const rail = screen.queryByRole('complementary')
  const shown = screen.getAllByText(text).filter((node) => !rail?.contains(node))
  expect(shown.length).toBeGreaterThan(0)
  return shown[0]!
}

describe('assistant reply speech integration (#105)', () => {
  it('synthesizes and plays the rendered assistant reply through the real TTS contract', async () => {
    const boundary = new ChatBoundary()
    installRealSpeechBridge(boundary)
    const user = userEvent.setup()
    renderChat({ conversationId: 'conversation-b' })

    await user.click(await screen.findByRole('button', { name: 'Speak' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Stop' })).toBeTruthy())

    expect(audios).toHaveLength(1)
    expect(audios[0]!.play).toHaveBeenCalledOnce()
    const [metadata, encoded] = audios[0]!.src.split(',')
    expect(metadata).toBe('data:audio/wav;base64')
    expect(Buffer.from(encoded!, 'base64').subarray(0, 4).toString('ascii')).toBe('RIFF')
    expect(fs.readFileSync(inputRecord, 'utf8')).toBe('Conversation B baseline')
    expect(fs.readFileSync(voiceRecord, 'utf8')).toBe('af_bella')
  })

  it('surfaces a real synthesis failure as an actionable rendered error', async () => {
    fs.writeFileSync(failureMarker, 'fail')
    const boundary = new ChatBoundary()
    installRealSpeechBridge(boundary)
    const user = userEvent.setup()
    renderChat({ conversationId: 'conversation-b' })

    await user.click(await screen.findByRole('button', { name: 'Speak' }))

    expect((await screen.findByRole('alert')).textContent).toMatch(
      /speech could not be generated.*text-to-speech is installed in settings/i
    )
    expect(audios).toHaveLength(0)
    expect(screen.getByRole('button', { name: 'Speak' })).toBeTruthy()
  })

  it('records, transcribes, chats, speaks, stops, recovers, and reopens one voice turn', async () => {
    const conversationId = 'voice-conversation-lifecycle'
    database.createRagConversation(conversationId, 'Voice lifecycle')
    fs.writeFileSync(failureMarker, 'fail')
    fakeLlama.reset()
    fakeLlama.enqueue(
      { content: '{"intent":"chat","urls":[]}' },
      { content: 'The release review is scheduled locally.', finishReason: 'stop' }
    )

    const trackStop = vi.fn()
    const stream = { getTracks: () => [{ stop: trackStop }] } as unknown as MediaStream
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia: async () => stream }
    })
    vi.stubGlobal('Blob', NodeBlob)
    vi.stubGlobal('MediaRecorder', RecorderBoundary)
    const NativeURL = URL
    vi.stubGlobal(
      'URL',
      class extends NativeURL {
        static createObjectURL = vi.fn(() => 'blob:synthetic-voice-note')
        static revokeObjectURL = vi.fn()
      }
    )

    const boundary = new ChatBoundary()
    installProductionVoiceBridge(boundary)
    const user = userEvent.setup()
    const view = renderChat({ conversationId })

    await user.click(await screen.findByTitle('Voice mode off'))
    await waitFor(() => expect(database.getSetting('composerVoiceMode', false)).toBe(true))

    await user.click(screen.getByText('Tap to record a voice note'))
    expect(RecorderBoundary.instances).toHaveLength(1)
    expect(RecorderBoundary.instances[0]!.state).toBe('recording')
    await user.click(screen.getByText('Recording — tap to send'))

    await waitFor(() => expect(screen.getAllByText('Show transcript')).toHaveLength(2), {
      timeout: 10_000
    })
    for (const toggle of screen.getAllByText('Show transcript')) await user.click(toggle)
    expect(screen.getByText('Schedule the stable release review')).toBeTruthy()
    expect(inTranscript('The release review is scheduled locally.')).toBeTruthy()
    expect((await screen.findByRole('alert')).textContent).toMatch(
      /speech could not be generated.*text-to-speech is installed in settings/i
    )
    expect(trackStop).toHaveBeenCalledOnce()

    await waitFor(() => {
      expect(
        database.getRagMessages(conversationId).map(({ role, content }) => [role, content])
      ).toEqual([
        ['user', 'Schedule the stable release review'],
        ['assistant', 'The release review is scheduled locally.']
      ])
    })

    await user.click(screen.getAllByTitle('Play').at(-1)!)
    await waitFor(() => expect(screen.getByTitle('Pause')).toBeTruthy())
    expect(audios).toHaveLength(1)
    expect(audios[0]!.play).toHaveBeenCalledOnce()
    await user.click(screen.getByTitle('Pause'))
    expect(audios[0]!.pause).toHaveBeenCalledOnce()

    view.unmount()
    installProductionVoiceBridge(new ChatBoundary())
    renderChat({ conversationId })

    expect(await screen.findByTitle('Voice mode on — speak and listen in voice notes')).toBeTruthy()
    const reopenedTranscripts = await screen.findAllByText('Show transcript')
    expect(reopenedTranscripts).toHaveLength(2)
    await user.click(reopenedTranscripts[1]!)
    expect(inTranscript('The release review is scheduled locally.')).toBeTruthy()
    expect(database.getSetting('ttsVoice', '')).toBe('af_bella')
    expect(database.getRagMessages(conversationId)).toHaveLength(2)

    await user.click(screen.getByTitle('Voice mode on — speak and listen in voice notes'))
    const composer = await screen.findByPlaceholderText(/^ask /i)
    await user.type(composer, 'Typed chat remains usable after voice recovery')
    expect((composer as HTMLTextAreaElement).value).toBe(
      'Typed chat remains usable after voice recovery'
    )
  }, 20_000)
})
