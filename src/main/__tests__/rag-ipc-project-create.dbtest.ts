import { afterAll, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

type Handler = (event: unknown, ...args: unknown[]) => unknown
const handlers = new Map<string, Handler>()
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-rag-ipc-project-'))

vi.mock('electron', () => ({
  app: { getPath: () => TMP_DIR, isPackaged: false, getAppPath: () => process.cwd() },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString()
  },
  ipcMain: { handle: (channel: string, handler: Handler) => handlers.set(channel, handler) },
  dialog: { showOpenDialog: vi.fn() },
  BrowserWindow: { fromWebContents: () => undefined }
}))

import { setupRagIPC } from '../rag-ipc'
import { listProjects } from '../rag/store'

afterAll(() => {
  fs.rmSync(TMP_DIR, { recursive: true, force: true })
})

describe('project IPC persistence', () => {
  it('creates durable projects with unique opaque identifiers', () => {
    setupRagIPC()
    const create = handlers.get('projects:create')
    expect(create).toBeTypeOf('function')

    const first = create!(undefined, { name: 'First project' }) as string
    const second = create!(undefined, { name: 'Second project' }) as string

    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(second).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(second).not.toBe(first)
    expect(listProjects().map(({ id, name }) => ({ id, name }))).toEqual(
      expect.arrayContaining([
        { id: first, name: 'First project' },
        { id: second, name: 'Second project' }
      ])
    )
  })

  it('edits every project field and restores the persisted values after a module reload', async () => {
    setupRagIPC()
    const create = handlers.get('projects:create')
    const update = handlers.get('projects:update')
    expect(create).toBeTypeOf('function')
    expect(update).toBeTypeOf('function')

    const projectId = create!(undefined, {
      name: 'Release planning',
      description: 'Initial notes',
      systemPrompt: 'Keep answers short',
      icon: 'folder'
    }) as string

    update!(undefined, projectId, {
      name: 'Launch planning',
      description: 'Decisions and launch risks',
      systemPrompt: 'Cite project documents before answering',
      icon: 'rocket',
      includeMemory: false
    })

    vi.resetModules()
    const reloadedStore = await import('../rag/store')
    const restored = reloadedStore.listProjects().find((project) => project.id === projectId)

    expect(restored).toMatchObject({
      id: projectId,
      name: 'Launch planning',
      description: 'Decisions and launch risks',
      systemPrompt: 'Cite project documents before answering',
      icon: 'rocket',
      includeMemory: false
    })
  })
})
