// @vitest-environment jsdom
/**
 * Renderer-to-main integration for the daily workspace spine. Electron itself and
 * the native model/vector runtimes are controlled boundaries; the production preload,
 * IPC handlers, React surfaces, repositories, SQLite, and artifact store stay real.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
// The DB Vitest config uses the classic JSX transform, which reads this binding at runtime.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  startFakeLlamaServer,
  type FakeLlamaServer
} from '../src/main/__tests__/harness/fake-llama-server'

interface IpcEvent {
  sender: {
    id: number
    send: (channel: string, payload: unknown) => void
    once: (channel: string, listener: () => void) => void
  }
}

type IpcHandler = (event: IpcEvent, ...args: unknown[]) => unknown
type IpcListener = (event: unknown, ...args: unknown[]) => void

const PROFILE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-workspace-bridge-'))
const previousUserData = process.env.OFFGRID_USER_DATA
const bridge = vi.hoisted(() => ({
  handlers: new Map<string, IpcHandler>(),
  mainListeners: new Map<string, IpcHandler>(),
  rendererListeners: new Map<string, Set<IpcListener>>()
}))

function emitToRenderer(channel: string, ...args: unknown[]): void {
  for (const listener of bridge.rendererListeners.get(channel) ?? []) listener({}, ...args)
}

const sender: IpcEvent['sender'] = {
  id: 1,
  send: (channel, payload) => emitToRenderer(channel, payload),
  once: () => undefined
}
const event: IpcEvent = { sender }

vi.mock('electron', () => ({
  app: {
    getPath: () => PROFILE_DIR,
    isPackaged: false,
    getAppPath: () => process.cwd(),
    getVersion: () => '0.0.40',
    on: () => undefined
  },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString()
  },
  ipcMain: {
    handle: (channel: string, handler: IpcHandler) => bridge.handlers.set(channel, handler),
    on: (channel: string, handler: IpcHandler) => bridge.mainListeners.set(channel, handler)
  },
  ipcRenderer: {
    invoke: async (channel: string, ...args: unknown[]) => {
      const handler = bridge.handlers.get(channel)
      if (!handler) throw new Error(`No production IPC handler registered for ${channel}`)
      return handler(event, ...args)
    },
    send: (channel: string, ...args: unknown[]) => {
      bridge.mainListeners.get(channel)?.(event, ...args)
    },
    sendSync: () => false,
    on: (channel: string, listener: IpcListener) => {
      const listeners = bridge.rendererListeners.get(channel) ?? new Set<IpcListener>()
      listeners.add(listener)
      bridge.rendererListeners.set(channel, listeners)
    },
    removeListener: (channel: string, listener: IpcListener) => {
      bridge.rendererListeners.get(channel)?.delete(listener)
    },
    removeAllListeners: (channel: string) => bridge.rendererListeners.delete(channel)
  },
  contextBridge: {
    exposeInMainWorld: (name: string, value: unknown) => {
      Object.defineProperty(window, name, { configurable: true, writable: true, value })
    }
  },
  BrowserWindow: {
    fromWebContents: () => undefined,
    getAllWindows: () => []
  },
  clipboard: { readText: () => '', writeText: () => undefined },
  systemPreferences: {
    isTrustedAccessibilityClient: () => true,
    getMediaAccessStatus: () => 'granted'
  },
  shell: { openExternal: async () => undefined, openPath: async () => '' },
  desktopCapturer: { getSources: async () => [] },
  dialog: {
    showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
    showSaveDialog: async () => ({ canceled: true })
  }
}))

vi.mock('@xenova/transformers', () => ({
  env: {},
  pipeline: async () => async () => ({ data: new Float32Array(384).fill(0.01) })
}))

vi.mock('@lancedb/lancedb', () => ({
  connect: async () => ({
    tableNames: async () => [],
    openTable: async () => {
      throw new Error('no vector table in this disposable profile')
    }
  })
}))

let fake: FakeLlamaServer
let MemoryChat: typeof import('../src/renderer/src/components/MemoryChat').MemoryChat
let ProjectsScreen: typeof import('../src/renderer/src/components/ProjectsScreen').ProjectsScreen
let TooltipProvider: typeof import('../src/renderer/src/components/ui/tooltip').TooltipProvider

async function bootProductionMain(): Promise<void> {
  bridge.handlers.clear()
  bridge.mainListeners.clear()
  const [{ setupIPC }, { setupRagIPC }, { registerTaskHistoryIpc }] = await Promise.all([
    import('../src/main/ipc'),
    import('../src/main/rag-ipc'),
    import('../src/main/tasks/task-history-ipc')
  ])
  setupIPC()
  setupRagIPC()
  registerTaskHistoryIpc()
}

function renderChat(target?: { conversationId?: string; projectId?: string }): void {
  render(
    <TooltipProvider>
      <MemoryChat openTarget={target} />
    </TooltipProvider>
  )
}

beforeAll(async () => {
  process.env.OFFGRID_USER_DATA = PROFILE_DIR
  fake = await startFakeLlamaServer()
  await bootProductionMain()
  await import('../src/preload/index')
  await window.api.setRemoteVisionServer({
    provider: 'custom',
    endpoint: `http://127.0.0.1:${fake.port}/v1`,
    model: 'integration-model'
  })
  ;({ MemoryChat } = await import('../src/renderer/src/components/MemoryChat'))
  ;({ ProjectsScreen } = await import('../src/renderer/src/components/ProjectsScreen'))
  ;({ TooltipProvider } = await import('../src/renderer/src/components/ui/tooltip'))
}, 30_000)

beforeEach(() => {
  ;(Element.prototype as unknown as { scrollIntoView: () => void }).scrollIntoView = () => {}
  globalThis.requestAnimationFrame = (callback: FrameRequestCallback): number => {
    callback(0)
    return 1
  }
})

afterEach(() => {
  cleanup()
  fake.reset()
})

afterAll(async () => {
  const { getDB } = await import('../src/main/database')
  if (getDB().open) getDB().close()
  await fake.close()
  fs.rmSync(PROFILE_DIR, { recursive: true, force: true })
  if (previousUserData === undefined) delete process.env.OFFGRID_USER_DATA
  else process.env.OFFGRID_USER_DATA = previousUserData
})

/**
 * The reply as the TRANSCRIPT shows it, not the copy in the history rail.
 *
 * The chat list shows each conversation's last message as a preview, so a reply is legitimately on
 * screen twice - once in its bubble and once in the rail - and a bare findByText throws "found multiple
 * elements" for a UI that is behaving correctly. Scoping to the transcript keeps the assertion about the
 * thing under test: the answer that came back through preload, IPC, the model socket and SQLite.
 *
 * The rail is the <aside> (role complementary), so anything outside it is transcript.
 */
async function inTranscript(text: string | RegExp): Promise<HTMLElement> {
  return waitFor(() => {
    const rail = screen.queryByRole('complementary')
    const shown = screen.getAllByText(text).filter((node) => !rail?.contains(node))
    expect(shown.length).toBeGreaterThan(0)
    return shown[0]!
  })
}

describe('production workspace bridge', () => {
  it('sends a rendered chat turn through preload, IPC, the model socket, and SQLite', async () => {
    fake.enqueue(
      { content: '{"intent":"chat","urls":[]}' },
      { content: 'The production bridge persisted this answer.' }
    )
    const user = userEvent.setup()
    renderChat()

    const composer = await screen.findByPlaceholderText(/^ask /i)
    fireEvent.change(composer, { target: { value: 'Prove the complete local chat path' } })
    await user.click(screen.getByRole('button', { name: /^send$/i }))

    expect(await inTranscript('The production bridge persisted this answer.')).toBeTruthy()
    const { getRagConversations, getRagMessages } = await import('../src/main/database')
    await waitFor(() => {
      const conversation = getRagConversations().find(
        ({ title }) => title === 'Prove the complete local chat path'
      )
      expect(conversation).toBeTruthy()
      expect(getRagMessages(conversation!.id).map(({ role, content }) => [role, content])).toEqual([
        ['user', 'Prove the complete local chat path'],
        ['assistant', 'The production bridge persisted this answer.']
      ])
    })
    expect(fake.requests).toHaveLength(2)
  })

  it('shows the real memory-chat failure instead of a fabricated answer', async () => {
    fake.enqueue(
      { content: '{"intent":"chat","urls":[]}' },
      {
        errorStatus: 503,
        errorBody: JSON.stringify({ error: { message: 'Memory model is unavailable.' } })
      }
    )
    const user = userEvent.setup()
    renderChat()

    const composer = await screen.findByPlaceholderText(/^ask /i)
    await user.click(screen.getByRole('button', { name: 'New chat' }))
    fireEvent.change(composer, { target: { value: 'What did I work on today?' } })
    await user.click(screen.getByRole('button', { name: /^send$/i }))

    expect(await inTranscript(/Memory model is unavailable/)).toBeTruthy()
    expect(screen.queryByText('Sorry, I could not generate a response right now.')).toBeNull()
  })

  it('shows and saves a compaction notice when the chat reaches 80% of its context', async () => {
    const longAnswer = `Stored answer ${'A'.repeat(54_000)}`
    fake.enqueue(
      { content: '{"intent":"chat","urls":[]}' },
      { content: longAnswer },
      { content: '{"intent":"chat","urls":[]}' },
      { content: 'The next answer still works.' }
    )
    const user = userEvent.setup()
    renderChat()

    const composer = await screen.findByPlaceholderText(/^ask /i)
    await user.click(screen.getByRole('button', { name: 'New chat' }))
    fireEvent.change(composer, { target: { value: 'Start a long conversation' } })
    await user.click(screen.getByRole('button', { name: /^send$/i }))
    expect(await inTranscript(longAnswer)).toBeTruthy()

    fireEvent.change(composer, { target: { value: 'Continue after the context fills' } })
    await user.click(screen.getByRole('button', { name: /^send$/i }))
    expect(await inTranscript('The next answer still works.')).toBeTruthy()
    expect(
      await screen.findByText('Compacted conversation to make room for more messages.')
    ).toBeTruthy()
    const nextModelRequest = JSON.stringify(fake.requests.at(-1))
    expect(nextModelRequest).toContain('Earlier chat excerpts')
    expect(nextModelRequest).not.toContain(longAnswer)

    const { getRagConversations, getRagMessages } = await import('../src/main/database')
    const conversation = getRagConversations().find(
      ({ title }) => title === 'Start a long conversation'
    )
    expect(conversation).toBeTruthy()
    expect(getRagMessages(conversation!.id)).toEqual(
      expect.arrayContaining([expect.objectContaining({ content: '_Compacted_' })])
    )
  })

  it('renders projects, chats, messages, and artifacts after the real database reopens', async () => {
    const api = window.api
    const projectId = await api.createProject!({ name: 'Reopened Workspace' })
    await api.createRagConversation('reopened-chat', 'Durable planning chat', projectId)
    await api.addRagMessage('reopened-chat', 'user', 'Keep this project context')
    await api.addRagMessage('reopened-chat', 'assistant', 'Context retained locally')
    await api.saveArtifact({
      kind: 'html',
      code: '<h1>Durable artifact</h1>',
      title: 'Durable artifact',
      conversationId: 'reopened-chat',
      projectId
    })

    const { getDB } = await import('../src/main/database')
    getDB().close()
    expect(getDB().open).toBe(true)

    render(<ProjectsScreen onOpenChat={() => undefined} />)
    expect(await screen.findByRole('button', { name: 'Reopened Workspace' })).toBeTruthy()
    expect(await screen.findByText('Durable planning chat')).toBeTruthy()
    expect(screen.getByText(/2 messages/)).toBeTruthy()

    await userEvent.setup().click(screen.getByRole('button', { name: 'Artifacts' }))
    expect(await screen.findByText('Durable artifact')).toBeTruthy()

    cleanup()
    renderChat({ conversationId: 'reopened-chat' })
    expect(await inTranscript('Keep this project context')).toBeTruthy()
    expect(await inTranscript('Context retained locally')).toBeTruthy()
  })
})
