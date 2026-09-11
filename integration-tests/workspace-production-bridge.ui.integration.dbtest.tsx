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
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

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
const previousDataDir = process.env.OFFGRID_DATA_DIR
const bridge = vi.hoisted(() => ({
  handlers: new Map<string, IpcHandler>(),
  mainListeners: new Map<string, Set<IpcHandler>>(),
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
  // Mirrors the real Electron ipcMain surface the booted main modules use (handle / removeHandler /
  // on / removeListener / removeAllListeners), including Electron's one-handler-per-channel rule.
  ipcMain: {
    handle: (channel: string, handler: IpcHandler) => {
      if (bridge.handlers.has(channel)) {
        throw new Error(`Attempted to register a second handler for '${channel}'`)
      }
      bridge.handlers.set(channel, handler)
    },
    removeHandler: (channel: string) => {
      bridge.handlers.delete(channel)
    },
    on: (channel: string, listener: IpcHandler) => {
      const listeners = bridge.mainListeners.get(channel) ?? new Set<IpcHandler>()
      listeners.add(listener)
      bridge.mainListeners.set(channel, listeners)
    },
    removeListener: (channel: string, listener: IpcHandler) => {
      bridge.mainListeners.get(channel)?.delete(listener)
    },
    removeAllListeners: (channel?: string) => {
      if (channel === undefined) bridge.mainListeners.clear()
      else bridge.mainListeners.delete(channel)
    }
  },
  ipcRenderer: {
    invoke: async (channel: string, ...args: unknown[]) => {
      const handler = bridge.handlers.get(channel)
      if (!handler) throw new Error(`No production IPC handler registered for ${channel}`)
      return handler(event, ...args)
    },
    send: (channel: string, ...args: unknown[]) => {
      for (const listener of bridge.mainListeners.get(channel) ?? []) listener(event, ...args)
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

let MemoryChat: typeof import('../src/renderer/src/components/MemoryChat').MemoryChat
let ProjectsScreen: typeof import('../src/renderer/src/components/ProjectsScreen').ProjectsScreen
let TooltipProvider: typeof import('../src/renderer/src/components/ui/tooltip').TooltipProvider
let stopDesktopApplication: (() => Promise<void>) | undefined
let stopActionsIpc: (() => void) | undefined

async function bootProductionMain(): Promise<void> {
  bridge.handlers.clear()
  bridge.mainListeners.clear()
  const [
    { setupIPC },
    { setupRagIPC },
    { registerTaskHistoryIpc },
    { registerActionsIpc },
    { startDesktopApplication, stopDesktopApplication: stopApplication }
  ] = await Promise.all([
    import('../src/main/ipc'),
    import('../src/main/rag-ipc'),
    import('../src/main/tasks/task-history-ipc'),
    import('../src/main/actions/actions-ipc'),
    import('../src/main/composition/application')
  ])
  const started = await startDesktopApplication()
  if (started.status !== 'running') {
    throw new Error(`Desktop application did not start: ${JSON.stringify(started)}`)
  }
  stopDesktopApplication = stopApplication
  setupIPC()
  setupRagIPC()
  registerTaskHistoryIpc()
  stopActionsIpc = registerActionsIpc()
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
  process.env.OFFGRID_DATA_DIR = PROFILE_DIR
  // Load the root before task-history IPC to preserve its production initialization order. Start
  // only after bootProductionMain clears the fixture maps, so startup registers fresh handlers.
  await import('../src/main/composition/application')
  await bootProductionMain()
  await import('../src/preload/index')
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
})

afterAll(async () => {
  stopActionsIpc?.()
  await stopDesktopApplication?.()
  const { getDB } = await import('../src/main/database')
  if (getDB().open) getDB().close()
  fs.rmSync(PROFILE_DIR, { recursive: true, force: true })
  if (previousUserData === undefined) delete process.env.OFFGRID_USER_DATA
  else process.env.OFFGRID_USER_DATA = previousUserData
  if (previousDataDir === undefined) delete process.env.OFFGRID_DATA_DIR
  else process.env.OFFGRID_DATA_DIR = previousDataDir
  bridge.handlers.clear()
  bridge.mainListeners.clear()
  bridge.rendererListeners.clear()
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
async function inTranscript(text: string): Promise<HTMLElement> {
  return waitFor(() => {
    const rail = screen.queryByRole('complementary')
    const shown = screen.getAllByText(text).filter((node) => !rail?.contains(node))
    expect(shown.length).toBeGreaterThan(0)
    return shown[0]!
  })
}

describe('production workspace bridge', () => {
  it('renders projects, chats, messages, and artifacts from the durable canonical tables', async () => {
    const api = window.api
    const project = await api.workspaceContent.execute({
      type: 'create_project',
      name: 'Reopened Workspace'
    })
    if (!project.ok) throw new Error(project.failure.message)
    const createdProject = project.value.changes.find(
      (change) => change.kind === 'put' && change.entity === 'project'
    )
    if (!createdProject) throw new Error('Project creation returned no canonical project record.')
    const projectId = createdProject.record.id
    const conversation = await api.workspaceContent.execute({
      type: 'create_conversation',
      conversationId: 'reopened-chat',
      title: 'Durable planning chat',
      projectId
    })
    if (!conversation.ok) throw new Error(conversation.failure.message)
    for (const portable of [
      { role: 'user' as const, content: 'Keep this project context' },
      { role: 'assistant' as const, content: 'Context retained locally' }
    ]) {
      const message = await api.workspaceContent.execute({
        type: 'append_message',
        conversationId: 'reopened-chat',
        portable
      })
      if (!message.ok) throw new Error(message.failure.message)
    }
    await api.saveArtifact({
      kind: 'html',
      code: '<h1>Durable artifact</h1>',
      title: 'Durable artifact',
      conversationId: 'reopened-chat',
      projectId
    })

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

  it('shows a canonically durable generated image in Gallery', async () => {
    const imageId = '44444444-4444-4444-8444-444444444444'
    const imagePath = path.join(PROFILE_DIR, 'generated-images', `${imageId}.png`)
    fs.mkdirSync(path.dirname(imagePath), { recursive: true })
    fs.writeFileSync(imagePath, Buffer.from('durable-image-bytes'))

    const { desktopApplication } = await import('../src/main/composition/application')
    if (!desktopApplication.generatedImages) throw new Error('Generated Images is unavailable.')
    const created = await desktopApplication.generatedImages.create({
      id: imageId,
      contentId: imageId,
      conversationId: null,
      prompt: 'A durable local proof image',
      width: 512,
      height: 512,
      steps: 8,
      seed: 7,
      modelId: 'proof-model',
      createdAt: '2026-09-06T00:00:00.000Z',
      local: { path: imagePath, fileName: `${imageId}.png` }
    })
    if (!created.ok) throw new Error(created.failure.message)

    renderChat({ openGallery: true })
    expect(await screen.findByAltText(`${imageId}.png`)).toBeTruthy()
  })
})
