import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3-multiple-ciphers'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createOffGridApplication,
  createWorkspaceContentChatSessionRepository
} from '../../../../shared/packages/application/src'
import { DesktopWorkspaceContentRepository } from '../workspace-content/repository'
import { initializeWorkspaceContentSchema } from '../workspace-content/schema'

let directory: string | undefined
afterEach(() => {
  if (directory) rmSync(directory, { recursive: true, force: true })
  directory = undefined
})

function models(): Parameters<typeof createOffGridApplication>[0]['models'] {
  return {
    selection: { read: () => null, write: () => undefined },
    memory: {
      current: () => ({ totalMB: 8_000, availableMB: 8_000, platform: 'desktop' as const })
    },
    inventoryAdapters: [{ id: 'test', listModels: async () => [] }],
    remote: {
      configuration: {
        read: () => ({ version: 1, activeServerId: null, servers: [] }),
        write: () => undefined
      },
      credentials: {
        read: async () => null,
        write: async () => undefined,
        remove: async () => undefined
      },
      providers: { register: async () => undefined, unregister: async () => undefined },
      activateManaged: async () => ({})
    }
  }
}

const gallery = {
  read: async () => ({ revision: '0', images: [] }),
  replace: async () => true
}

function open(path: string): {
  db: Database.Database
  root: ReturnType<typeof createOffGridApplication>
} {
  const db = new Database(path)
  initializeWorkspaceContentSchema(db)
  db.prepare(
    `INSERT OR IGNORE INTO workspace_content_migration_journal
    (target_version,status,started_at,finished_at,failure_message)
    VALUES (1,'completed',?,?,NULL)`
  ).run('2024-01-01T00:00:00.000Z', '2024-01-01T00:00:00.000Z')
  const root = createOffGridApplication({
    models: models(),
    workspaceContent: new DesktopWorkspaceContentRepository(db),
    generatedImageGallery: gallery
  })
  return { db, root }
}

describe('Workspace Content attachment local identity', () => {
  it('persists and reconciles locations by contentId through a real restart', async () => {
    directory = mkdtempSync(join(tmpdir(), 'offgrid-attachment-location-'))
    const path = join(directory, 'workspace.sqlite')
    let runtime = open(path)
    expect((await runtime.root.start()).status).toBe('running')
    expect(
      await runtime.root.workspaceContent.execute({
        type: 'create_conversation',
        conversationId: 'conversation-1',
        title: 'Attachments'
      })
    ).toMatchObject({ ok: true })

    const ids = ['image-a', 'audio-b', 'file-c']
    const chat = createWorkspaceContentChatSessionRepository({
      workspaceContent: runtime.root.workspaceContent,
      newId: () => ids.shift() ?? 'unexpected-id',
      now: () => Date.parse('2024-01-02T03:04:05.000Z')
    })
    await chat.write('conversation-1', [
      {
        id: 'turn-1',
        conversationId: 'conversation-1',
        userMessageId: 'user-1',
        responseMessageIds: ['response-1'],
        userMessage: {
          role: 'user',
          content: [
            { type: 'image', mimeType: 'image/png', uri: '/device/a.png' },
            { type: 'audio', mimeType: 'audio/wav', data: 'audio-bytes' },
            { type: 'file', name: 'c.txt', mimeType: 'text/plain', uri: '/device/c.txt' }
          ]
        },
        responseMessages: [{ role: 'assistant', content: 'done' }],
        status: 'completed',
        request: { operation: { type: 'text' }, request: {} }
      }
    ])
    expect(runtime.root.workspaceContent.snapshot().messages[0]!.local?.contentLocations).toEqual([
      { contentId: 'image-a', uri: '/device/a.png' },
      { contentId: 'audio-b', data: 'audio-bytes' },
      { contentId: 'file-c', uri: '/device/c.txt' }
    ])

    await runtime.root.stop()
    runtime.db
      .prepare('UPDATE workspace_content_local_message_state SET state_json=? WHERE message_id=?')
      .run(
        JSON.stringify({
          note: 'keep-me',
          contentLocations: [
            { contentId: 'image-a', uri: '/device/a.png' },
            { contentId: 'audio-b', data: 'audio-bytes' },
            { contentId: 'audio-b', uri: '/device/ambiguous.wav' },
            { contentId: 'file-c', uri: '/device/c.txt' },
            { contentId: 'stale', uri: '/device/stale' },
            { index: 0, uri: '/device/legacy-index' }
          ]
        }),
        'user-1'
      )
    runtime.db.close()

    runtime = open(path)
    expect((await runtime.root.start()).status).toBe('running')
    const snapshot = runtime.root.workspaceContent.snapshot()
    const user = snapshot.messages.find((message) => message.id === 'user-1')!
    const response = snapshot.messages.find((message) => message.id === 'response-1')!
    const turn = snapshot.chatTurns[0]
    const parts = user.portable.content
    if (typeof parts === 'string') throw new Error('Expected rich content')
    const imagePart = parts[0]!
    const filePart = parts[2]!
    expect(
      await runtime.root.workspaceContent.execute({
        type: 'replace_chat_session',
        conversationId: 'conversation-1',
        origin: 'remote',
        messages: [
          {
            ...user,
            portable: { ...user.portable, content: [filePart, imagePart] },
            local: undefined
          },
          { ...response, local: undefined }
        ],
        turns: [turn!]
      })
    ).toMatchObject({ ok: true })
    const settled = runtime.root.workspaceContent
      .snapshot()
      .messages.find((message) => message.id === 'user-1')!
    expect(settled.local).toEqual({
      note: 'keep-me',
      contentLocations: [
        { contentId: 'image-a', uri: '/device/a.png' },
        { contentId: 'file-c', uri: '/device/c.txt' }
      ]
    })

    const revision = runtime.root.workspaceContent.snapshot().revision
    expect(
      await runtime.root.workspaceContent.execute({
        type: 'update_message',
        messageId: 'user-1',
        portable: {
          role: 'user',
          content: [imagePart, imagePart]
        },
        origin: 'local'
      })
    ).toMatchObject({ ok: false, failure: { kind: 'invalid_input' } })
    expect(runtime.root.workspaceContent.snapshot().revision).toBe(revision)

    const projected = await createWorkspaceContentChatSessionRepository({
      workspaceContent: runtime.root.workspaceContent,
      newId: () => 'unused'
    }).read('conversation-1')
    expect(projected[0]!.userMessage.content).toEqual([
      { ...filePart, uri: '/device/c.txt' },
      { ...imagePart, uri: '/device/a.png' }
    ])
    await runtime.root.stop()
    runtime.db.close()

    runtime = open(path)
    expect((await runtime.root.start()).status).toBe('running')
    expect(
      runtime.root.workspaceContent.snapshot().messages.find((message) => message.id === 'user-1')
        ?.local
    ).toEqual(settled.local)
    await runtime.root.stop()
    runtime.db.close()
  })
})
