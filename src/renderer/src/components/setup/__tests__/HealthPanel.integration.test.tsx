// @vitest-environment jsdom
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  SYSTEM_HEALTH_STATUS_LABELS,
  type SystemHealthContract
} from '../../../../../shared/ipc-contracts'
import { configureRuntime } from '../../../../../main/runtime-env'
import { setupSystemStatusIpc } from '../../../../../main/system-status-ipc'
import { HealthPanel } from '../HealthPanel'

const tccBoundary = vi.hoisted(() => ({
  accessibility: true,
  screenRecording: false,
  error: null as unknown
}))

vi.mock('electron', () => ({
  app: {
    getPath: () => process.env.OFFGRID_DATA_DIR ?? process.cwd(),
    getAppPath: () => process.cwd(),
    getVersion: () => 'integration',
    isPackaged: false
  },
  systemPreferences: {
    isTrustedAccessibilityClient: () => tccBoundary.accessibility,
    getMediaAccessStatus: () => {
      if (tccBoundary.error !== null) throw tccBoundary.error
      return tccBoundary.screenRecording ? 'granted' : 'denied'
    }
  },
  shell: { openExternal: async () => undefined },
  desktopCapturer: { getSources: async () => [] }
}))

vi.mock('node:dgram', () => ({
  default: {
    createSocket: () => ({
      once: () => undefined,
      send: (
        _message: Buffer,
        _port: number,
        _host: string,
        callback: (error: Error | null) => void
      ) => callback(null),
      close: () => undefined
    })
  }
}))

type IpcHandler = (event: unknown, ...args: unknown[]) => unknown

class NativeIpcBoundary {
  private readonly handlers = new Map<string, IpcHandler>()

  handle(channel: string, listener: IpcHandler): void {
    this.handlers.set(channel, listener)
  }

  async invoke(channel: string, ...args: unknown[]): Promise<unknown> {
    const handler = this.handlers.get(channel)
    if (!handler) throw new Error(`No IPC handler registered for ${channel}`)
    return handler({}, ...args)
  }
}

const boundary = new NativeIpcBoundary()

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-system-health-'))
const profile = path.join(root, 'profile')
const binRoot = path.join(root, 'bin')
const enginePath = path.join(binRoot, 'llama', 'llama-server')
const ffmpegPath = path.join(binRoot, 'ffmpeg')
const whisperPath = path.join(binRoot, 'whisper', 'whisper-cli')
const snapshots: SystemHealthContract[] = []
const previousDataDir = process.env.OFFGRID_DATA_DIR
const previousBinDir = process.env.OFFGRID_BIN_DIR

function executable(target: string, source: string): void {
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, `#!/usr/bin/env node\n${source}\n`)
  fs.chmodSync(target, 0o755)
}

function writeHealthyEngine(): void {
  executable(
    enginePath,
    String.raw`
const http = require('node:http')
const args = process.argv.slice(2)
const index = args.indexOf('--port')
const port = index >= 0 ? Number(args[index + 1]) : 8439
const server = http.createServer((request, response) => {
  response.setHeader('Content-Type', 'application/json')
  if (request.url === '/health') return response.end(JSON.stringify({ status: 'ok' }))
  if (request.url === '/v1/models') return response.end(JSON.stringify({ data: [{ id: 'fixture-chat' }] }))
  response.statusCode = 404
  response.end('{}')
})
server.listen(port, '127.0.0.1')
const stop = () => server.close(() => process.exit(0))
process.on('SIGTERM', stop)
process.on('SIGINT', stop)
`
  )
}

function latestComponent(id: string): SystemHealthContract['components'][number] {
  const component = snapshots.at(-1)?.components.find((candidate) => candidate.id === id)
  if (!component) throw new Error(`Missing production health record ${id}`)
  return component
}

function expectRenderedRecord(id: string): void {
  const component = latestComponent(id)
  const card = screen.getByRole('status', { name: component.label })
  expect(within(card).getByText(SYSTEM_HEALTH_STATUS_LABELS[component.status])).not.toBeNull()
  if (component.detail) expect(within(card).getByText(component.detail)).not.toBeNull()
}

beforeAll(async () => {
  process.env.OFFGRID_DATA_DIR = profile
  process.env.OFFGRID_BIN_DIR = binRoot
  configureRuntime({ dataDir: profile, binRoots: [binRoot] })

  const model = path.join(profile, 'models', 'gemma-4-E4B-it-Q4_K_M.gguf')
  fs.mkdirSync(path.dirname(model), { recursive: true })
  const gguf = Buffer.alloc(2048, 7)
  gguf.write('GGUF')
  fs.writeFileSync(model, gguf)
  writeHealthyEngine()
  executable(ffmpegPath, "process.stdout.write('ffmpeg version integration\\n')")
  executable(whisperPath, "process.stdout.write('usage: whisper-cli [options]\\n')")

  setupSystemStatusIpc(boundary)
  ;(globalThis as unknown as { window: { api: unknown } }).window.api = {
    systemHealth: async () => {
      const snapshot = (await boundary.invoke('system:health')) as SystemHealthContract
      snapshots.push(snapshot)
      return snapshot
    },
    restartComponent: async () => ({ success: true }),
    // Wire the UI button to the REAL engine teardown so the test exercises the actual unload path.
    unloadLlmEngine: async () => {
      const { llm } = await import('../../../../../main/llm')
      return llm.unload()
    }
  }

  const { llm } = await import('../../../../../main/llm')
  await llm.restart()
})

afterAll(async () => {
  cleanup()
  const { llm } = await import('../../../../../main/llm')
  llm.pause()
  fs.rmSync(root, { recursive: true, force: true })
  if (previousDataDir === undefined) delete process.env.OFFGRID_DATA_DIR
  else process.env.OFFGRID_DATA_DIR = previousDataDir
  if (previousBinDir === undefined) delete process.env.OFFGRID_BIN_DIR
  else process.env.OFFGRID_BIN_DIR = previousBinDir
})

describe('<HealthPanel/> production status integration', () => {
  it('renders the same engine, helper, and permission records produced by main IPC (#13)', async () => {
    const user = userEvent.setup()
    render(<HealthPanel />)

    await screen.findByRole('status', { name: 'Chat model (llama-server)' })
    await expect(boundary.invoke('permissions:get-status')).resolves.toEqual({
      accessibility: true,
      screenRecording: false,
      localNetwork: true,
      allGranted: false
    })
    expect(latestComponent('chat').status).toBe('ready')
    expectRenderedRecord('chat')
    expect(latestComponent('helper-ffmpeg').status).toBe('installed')
    expectRenderedRecord('helper-ffmpeg')
    expect(latestComponent('helper-whisper').status).toBe('installed')
    expectRenderedRecord('helper-whisper')
    expect(latestComponent('permission-accessibility').status).toBe('granted')
    expectRenderedRecord('permission-accessibility')
    expect(latestComponent('permission-screen-recording').status).toBe('denied')
    expectRenderedRecord('permission-screen-recording')
    expect(latestComponent('permission-local-network').status).toBe('granted')
    expectRenderedRecord('permission-local-network')

    tccBoundary.accessibility = false
    tccBoundary.screenRecording = true
    fs.rmSync(whisperPath)
    await user.click(screen.getByRole('button', { name: 'Refresh' }))

    await waitFor(() =>
      expect(latestComponent('permission-screen-recording').status).toBe('granted')
    )
    expectRenderedRecord('permission-screen-recording')
    expect(latestComponent('permission-accessibility').status).toBe('denied')
    expectRenderedRecord('permission-accessibility')
    expect(latestComponent('helper-whisper').status).toBe('not_installed')
    expectRenderedRecord('helper-whisper')

    tccBoundary.error = new Error('TCC database unavailable')
    await user.click(screen.getByRole('button', { name: 'Refresh' }))
    await waitFor(() => expect(latestComponent('permission-accessibility').status).toBe('down'))
    expectRenderedRecord('permission-accessibility')
    expectRenderedRecord('permission-screen-recording')
    expectRenderedRecord('permission-local-network')

    tccBoundary.error = 'TCC bridge unavailable'
    await user.click(screen.getByRole('button', { name: 'Refresh' }))
    await waitFor(() =>
      expect(latestComponent('permission-accessibility').detail).toContain('TCC bridge unavailable')
    )
    expectRenderedRecord('permission-accessibility')
    expectRenderedRecord('permission-screen-recording')
    expectRenderedRecord('permission-local-network')

    executable(
      enginePath,
      'process.stderr.write("unknown model architecture: \'gemma4\'\\n"); setTimeout(() => process.exit(23), 20)'
    )
    const { llm } = await import('../../../../../main/llm')
    await expect(llm.restart()).rejects.toThrow(/did not come back up/i)
    llm.pause()
    await user.click(screen.getByRole('button', { name: 'Refresh' }))

    await waitFor(() => expect(latestComponent('chat').status).toBe('down'))
    expectRenderedRecord('chat')
    const chat = screen.getByRole('status', { name: 'Chat model (llama-server)' })
    expect(within(chat).getByText(/engine is too old/i)).not.toBeNull()
    expect(within(chat).getByText(/gemma4/i)).not.toBeNull()
  })

  it('frees the running engine on demand — stops llama-server and releases the port (#7)', async () => {
    cleanup() // clear the prior render in this shared-harness file
    // Bring a healthy fixture engine up (the previous test left it broken); restart() clears pause.
    writeHealthyEngine()
    const { llm } = await import('../../../../../main/llm')
    await llm.restart()
    expect(llm.isReady()).toBe(true)

    const user = userEvent.setup()
    render(<HealthPanel />)
    await screen.findByRole('status', { name: 'Chat model (llama-server)' })

    await user.click(screen.getByRole('button', { name: 'Free engine' }))

    // The REAL engine was torn down and its port reported free (portFree came back true, which
    // required the fixture llama-server to actually exit and the port to have no live owner).
    expect(await screen.findByText(/port freed/i)).toBeTruthy()
    expect(llm.isReady()).toBe(false)
  })
})
