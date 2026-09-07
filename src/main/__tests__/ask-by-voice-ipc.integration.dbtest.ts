/**
 * Voice-question transport through the real Shared workflow. This device composition intentionally
 * has no native speech port, so valid recorded bytes produce the real started/typed-failure journey.
 * Electron IPC, the main window, and the profile are the only external process fakes.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { OffGridApplication } from '@offgrid/application'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

type IpcHandler = (event: { sender: unknown }, ...args: unknown[]) => unknown

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-ask-by-voice-ipc-'))
const originalDataDir = process.env.OFFGRID_DATA_DIR
const originalDiagnosticLog = process.env.OFFGRID_DIAGNOSTIC_LOG
const originalSkipCompatibleGenerationModel = process.env.OFFGRID_SKIP_COMPATIBLE_GENERATION_MODEL
process.env.OFFGRID_DATA_DIR = profile
process.env.OFFGRID_DIAGNOSTIC_LOG = path.join(profile, 'voice-diagnostics.log')
process.env.OFFGRID_SKIP_COMPATIBLE_GENERATION_MODEL = '1'

const handlers = new Map<string, IpcHandler>()
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
    on: () => undefined,
    removeListener: () => undefined
  }
}))

const { getDB } = await import('../database')
const { flushDiagnosticLog } = await import('../diagnostics-log')
const { registerDesktopApplication } = await import('../composition/application-access')
const { setMainWindow } = await import('../main-window')
const { applicationShutdown } = await import('../shutdown')
const { setupAskByVoiceIpc } = await import('../ask-by-voice-ipc')
const { ASK_BY_VOICE_CANCEL_CHANNEL, ASK_BY_VOICE_EVENT_CHANNEL, ASK_BY_VOICE_START_CHANNEL } =
  await import('../../shared/ask-by-voice-contract')

let application: OffGridApplication
let releaseApplication: () => void

beforeAll(async () => {
  const [{ createOffGridApplication }, { desktopModelWorkspacePorts }] = await Promise.all([
    import('@offgrid/application'),
    import('../model-services')
  ])
  application = createOffGridApplication({ models: desktopModelWorkspacePorts })
  releaseApplication = registerDesktopApplication(application)
  await application.start()
  setMainWindow(mainWindow as never)
  setupAskByVoiceIpc(async () => application)
})

afterAll(async () => {
  await applicationShutdown.shutdown()
  await application.stop()
  releaseApplication()
  await flushDiagnosticLog()
  if (getDB().open) getDB().close()
  if (originalDataDir === undefined) delete process.env.OFFGRID_DATA_DIR
  else process.env.OFFGRID_DATA_DIR = originalDataDir
  if (originalDiagnosticLog === undefined) delete process.env.OFFGRID_DIAGNOSTIC_LOG
  else process.env.OFFGRID_DIAGNOSTIC_LOG = originalDiagnosticLog
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

describe('voice-question IPC through the real Shared workflow', () => {
  it('returns one run identity and forwards the typed workflow failure', async () => {
    const started = await invoke(ASK_BY_VOICE_START_CHANNEL, renderer, {
      bytes: Uint8Array.from([82, 73, 70, 70]),
      mimeType: 'audio/wav',
      projectId: null,
      speak: false
    })
    expect(started).toMatchObject({ operationId: expect.any(String) })

    await vi.waitFor(() =>
      expect(sent.map(({ payload }) => payload)).toContainEqual(
        expect.objectContaining({
          operationId: (started as { operationId: string }).operationId,
          event: expect.objectContaining({ type: 'failed' })
        })
      )
    )
    expect(sent.every(({ channel }) => channel === ASK_BY_VOICE_EVENT_CHANNEL)).toBe(true)

    await expect(
      invoke(
        ASK_BY_VOICE_CANCEL_CHANNEL,
        renderer,
        (started as { operationId: string }).operationId
      )
    ).resolves.toBeUndefined()
  })

  it('rejects malformed commands and non-main renderers before workflow work starts', async () => {
    await expect(
      invoke(ASK_BY_VOICE_START_CHANNEL, renderer, { bytes: new Uint8Array() })
    ).rejects.toThrow('Invalid voice question.')
    await expect(
      invoke(
        ASK_BY_VOICE_START_CHANNEL,
        { id: 'overlay' },
        {
          bytes: Uint8Array.from([1]),
          mimeType: 'audio/wav'
        }
      )
    ).rejects.toThrow('Voice questions may only be started by the main window.')
    await expect(invoke(ASK_BY_VOICE_CANCEL_CHANNEL, renderer, '')).rejects.toThrow(
      'Invalid voice question id.'
    )
  })
})
