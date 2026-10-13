// The renderer's video journey through the real IPC handlers, job service, chat stream state,
// settings database and gallery. Only the external executables (`sd-cli`, `ffmpeg`) and Electron's
// windows and save dialog are stand-ins.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

type IpcHandler = (event: { sender: object }, ...args: unknown[]) => unknown

const TMP_DIR = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-ipc-video-')))
const handlers = new Map<string, IpcHandler>()
const sent: Array<{ channel: string; payload: unknown }> = []
const saveDialog: { filePath?: string; canceled: boolean } = { canceled: true }

vi.mock('electron', () => {
  const window = {
    isDestroyed: () => false,
    webContents: { send: (channel: string, payload: unknown) => sent.push({ channel, payload }) }
  }
  return {
    app: { getPath: () => TMP_DIR, isPackaged: false, getAppPath: () => process.cwd(), on: () => undefined },
    safeStorage: {
      isEncryptionAvailable: () => false,
      encryptString: (value: string) => Buffer.from(value),
      decryptString: (value: Buffer) => value.toString()
    },
    ipcMain: {
      handle: (channel: string, handler: IpcHandler) => handlers.set(channel, handler),
      on: () => undefined
    },
    BrowserWindow: { getAllWindows: () => [window], fromWebContents: () => window },
    clipboard: { readText: () => '', writeText: () => undefined },
    systemPreferences: { isTrustedAccessibilityClient: () => true, getMediaAccessStatus: () => 'granted' },
    shell: { openExternal: async () => undefined, openPath: async () => '' },
    desktopCapturer: { getSources: async () => [] },
    dialog: { showSaveDialog: async () => ({ ...saveDialog }) }
  }
})

vi.mock('@huggingface/transformers', () => ({
  env: {},
  pipeline: async () => {
    throw new Error('embeddings are not part of this journey')
  }
}))

vi.mock('@lancedb/lancedb', () => ({
  connect: async () => ({ tableNames: async () => [], openTable: async () => { throw new Error('no table') } })
}))

import { configureRuntime } from '../runtime-env'
import { setupIPC } from '../ipc'

const PACK = ['wan2.1_t2v_1.3B_fp16.safetensors', 'wan_2.1_vae.safetensors', 'umt5-xxl-encoder-Q4_K_M.gguf']
const FAKE_SD_CLI = `#!/usr/bin/env node
const fs = require('node:fs')
const args = process.argv.slice(2)
if (args.includes('--help')) { process.stdout.write('usage: sd-cli\\n'); process.exit(0) }
if (args.includes('--list-devices')) process.exit(0)
const value = (flag) => args[args.indexOf(flag) + 1]
const steps = Number(value('--steps'))
for (let step = 1; step <= steps; step += 1) process.stderr.write('  | ' + step + '/' + steps + ' - 0.10s/it\\r')
process.stderr.write('OFFGRID_VIDEO_DECODE 1 1\\n')
fs.writeFileSync(value('-o'), 'synthetic clip')
`
const FAKE_FFMPEG = `#!/usr/bin/env node
const fs = require('node:fs')
const args = process.argv.slice(2)
if (args.includes('-encoders')) { process.stdout.write(' V....D libx264  H.264 / AVC\\n'); process.exit(0) }
fs.copyFileSync(args[args.indexOf('-i') + 1], args.at(-1))
`
const event = { sender: {} }

function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  const handler = handlers.get(channel)
  if (!handler) throw new Error(`No handler for ${channel}`)
  return Promise.resolve(handler(event, ...args) as T)
}

function install(dir: string, name: string, source: string): void {
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, name), source, { mode: 0o755 })
}

beforeAll(() => {
  const bin = path.join(TMP_DIR, 'bin')
  install(path.join(bin, 'sd'), 'sd-cli', FAKE_SD_CLI)
  install(bin, 'ffmpeg', FAKE_FFMPEG)
  fs.mkdirSync(path.join(TMP_DIR, 'models'), { recursive: true })
  for (const name of PACK) fs.writeFileSync(path.join(TMP_DIR, 'models', name), 'weights')
  configureRuntime({ dataDir: TMP_DIR, modelsDir: path.join(TMP_DIR, 'models'), binRoots: [bin] })
  setupIPC()
})

afterAll(() => {
  fs.rmSync(TMP_DIR, { recursive: true, force: true })
})

describe.skipIf(process.platform === 'win32')('video over IPC', () => {
  const conversationId = '33333333-3333-4333-8333-333333333333'

  it('generates a clip for a chat, publishes its progress, and files it in the gallery', async () => {
    expect(await invoke('videogen:status')).toMatchObject({ available: true })
    expect(await invoke('videogen:cancel')).toBe(false)

    const result = await invoke<{ path: string; syncId: string }>('videogen:generate', {
      prompt: 'A red ball rolls across a table',
      steps: 4,
      conversationId
    })
    expect(fs.readFileSync(result.path, 'utf8')).toBe('synthetic clip')
    expect(await invoke('videogen:job-status')).toMatchObject({ phase: 'succeeded', outputPath: result.path })

    const states = sent.filter((entry) => entry.channel === 'videogen:job-state').map((entry) => entry.payload as { phase: string })
    expect(states.at(0)?.phase).toBe('running')
    expect(states.at(-1)?.phase).toBe('succeeded')

    const listed = await invoke<Array<{ path: string }>>('videogen:list', { conversationId })
    expect(listed.map((video) => video.path)).toEqual([result.path])
    expect(await invoke('videogen:list', { conversationId: 'another-chat' })).toEqual([])

    // The renderer saved the reply; the clip is linked to it and other windows are told.
    expect(await invoke('videogen:conversation-persisted', conversationId, '44444444-4444-4444-8444-444444444444')).toBe(true)
    expect(sent).toContainEqual({ channel: 'videogen:conversation-updated', payload: conversationId })
  })

  it('exports a clip only where the user chose, and deletes it from the gallery', async () => {
    const [video] = await invoke<Array<{ path: string }>>('videogen:list', { conversationId })
    saveDialog.canceled = true
    expect(await invoke('videogen:export', video!.path, 'clip.mp4')).toBe(false)

    const destination = path.join(TMP_DIR, 'exported.mp4')
    Object.assign(saveDialog, { canceled: false, filePath: destination })
    expect(await invoke('videogen:export', video!.path, 'clip.mp4')).toBe(true)
    expect(fs.readFileSync(destination, 'utf8')).toBe('synthetic clip')

    expect(await invoke('videogen:delete', video!.path)).toBe(true)
    expect(await invoke('videogen:list', { conversationId })).toEqual([])
  })

  it('reports a clip that cannot start and leaves nothing behind', async () => {
    fs.unlinkSync(path.join(TMP_DIR, 'models', 'wan_2.1_vae.safetensors'))
    expect(await invoke('videogen:status')).toMatchObject({ available: false })
    await expect(invoke('videogen:generate', { prompt: 'lake', steps: 4, conversationId })).rejects.toThrow(
      'complete video model pack'
    )
    expect(await invoke('videogen:list')).toEqual([])
  })
})
