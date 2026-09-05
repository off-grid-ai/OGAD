/**
 * Speech commands through the production Desktop application and Shared speech facade. This fresh
 * profile has no installed speech model, so transcription reaches the real typed failure path
 * without starting a native process. Electron IPC/window/profile APIs are the only fakes.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

type IpcHandler = (event: { sender: unknown }, ...args: unknown[]) => unknown

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-speech-command-ipc-'))
const originalDataDir = process.env.OFFGRID_DATA_DIR
const originalSkipCompatibleGenerationModel = process.env.OFFGRID_SKIP_COMPATIBLE_GENERATION_MODEL
process.env.OFFGRID_DATA_DIR = profile
process.env.OFFGRID_SKIP_COMPATIBLE_GENERATION_MODEL = '1'

const handlers = new Map<string, IpcHandler>()
const listeners = new Map<string, (...args: unknown[]) => unknown>()
const sent: Array<{ channel: string; payload: unknown }> = []
const renderer = {
  isDestroyed: () => false,
  send: (channel: string, payload: unknown) => sent.push({ channel, payload })
}
const mainWindow = { isDestroyed: () => false, webContents: renderer }

vi.mock('electron', () => ({
  app: {
    getPath: () => profile,
    getAppPath: () => process.cwd(),
    getVersion: () => 'test',
    isPackaged: false
  },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString()
  },
  BrowserWindow: { getAllWindows: () => [], getFocusedWindow: () => mainWindow },
  ipcMain: {
    handle: (channel: string, handler: IpcHandler) => handlers.set(channel, handler),
    removeHandler: (channel: string) => handlers.delete(channel),
    on: (channel: string, listener: (...args: unknown[]) => unknown) =>
      listeners.set(channel, listener),
    removeListener: (channel: string) => listeners.delete(channel)
  }
}))

const { getDB } = await import('../database')
const { setMainWindow } = await import('../main-window')
const { applicationShutdown } = await import('../shutdown')
const { setupSpeechCommandIpc } = await import('../speech-command-ipc')
const {
  SPEECH_CANCEL_TRANSCRIPTION_CHANNEL,
  SPEECH_EVENT_CHANNEL,
  SPEECH_FEED_STREAM_CHANNEL,
  SPEECH_INTERRUPT_CHANNEL,
  SPEECH_SPEAK_CHANNEL,
  SPEECH_TRANSCRIBE_CHANNEL
} = await import('../../shared/speech-command-contract')

beforeAll(async () => {
  setMainWindow(mainWindow as never)
  const { startDesktopApplication } = await import('../composition/application')
  await startDesktopApplication()
  setupSpeechCommandIpc()
})

afterAll(async () => {
  await applicationShutdown.shutdown()
  if (getDB().open) getDB().close()
  if (originalDataDir === undefined) delete process.env.OFFGRID_DATA_DIR
  else process.env.OFFGRID_DATA_DIR = originalDataDir
  if (originalSkipCompatibleGenerationModel === undefined)
    delete process.env.OFFGRID_SKIP_COMPATIBLE_GENERATION_MODEL
  else process.env.OFFGRID_SKIP_COMPATIBLE_GENERATION_MODEL = originalSkipCompatibleGenerationModel
  fs.rmSync(profile, { recursive: true, force: true })
})

function invoke(channel: string, sender: unknown, value?: unknown): unknown {
  const handler = handlers.get(channel)
  if (!handler) throw new Error(`IPC handler ${channel} was not registered.`)
  return handler({ sender }, value)
}

describe('speech command IPC through the real Desktop application', () => {
  it('returns the real transcription failure and forwards speech state', async () => {
    const outcome = await invoke(SPEECH_TRANSCRIBE_CHANNEL, renderer, {
      source: {
        kind: 'bytes',
        bytes: Uint8Array.from([82, 73, 70, 70]),
        mimeType: 'audio/wav'
      },
      operationId: 'speech-ipc-transcription',
      language: 'en'
    })
    expect(outcome).toMatchObject({ ok: false })
    expect(sent.some(({ channel }) => channel === SPEECH_EVENT_CHANNEL)).toBe(true)

    await expect(
      invoke(SPEECH_CANCEL_TRANSCRIPTION_CHANNEL, renderer, 'missing-transcription')
    ).resolves.toMatchObject({ ok: false })
    await expect(invoke(SPEECH_INTERRUPT_CHANNEL, renderer)).resolves.toBeUndefined()
  })

  it('rejects malformed commands and non-main renderers before application work', async () => {
    await expect(invoke(SPEECH_TRANSCRIBE_CHANNEL, renderer, null)).rejects.toThrow(
      'Invalid speech transcription command.'
    )
    await expect(invoke(SPEECH_CANCEL_TRANSCRIPTION_CHANNEL, renderer, '')).rejects.toThrow(
      'Invalid speech transcription operation ID.'
    )
    await expect(
      invoke(SPEECH_SPEAK_CHANNEL, renderer, { text: 'Hello', operationId: '' })
    ).rejects.toThrow('Invalid speech command.')
    await expect(
      invoke(SPEECH_FEED_STREAM_CHANNEL, renderer, { operationId: 'stream', delta: 42 })
    ).rejects.toThrow('Invalid speech stream command.')
    await expect(invoke(SPEECH_INTERRUPT_CHANNEL, { id: 'overlay' })).rejects.toThrow(
      'Speech commands are only available to the main renderer.'
    )
  })
})
