import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3-multiple-ciphers'
import { afterEach, describe, expect, it } from 'vitest'
import { createOffGridApplication } from '../../../../shared/packages/application/src'
import { DesktopWorkspaceContentRepository } from '../workspace-content/repository'
import { initializeWorkspaceContentSchema } from '../workspace-content/schema'

let directory: string | undefined
afterEach(() => {
  if (directory) rmSync(directory, { recursive: true, force: true })
  directory = undefined
})

const models = (): Parameters<typeof createOffGridApplication>[0]['models'] => ({
  selection: { read: () => null, write: () => undefined },
  memory: { current: () => ({ totalMB: 8_000, availableMB: 8_000, platform: 'desktop' }) },
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
})
const gallery = { read: async () => ({ revision: '0', images: [] }), replace: async () => true }
const timestamp = '2024-01-02T03:04:05.000Z'

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
  ).run(timestamp, timestamp)
  return {
    db,
    root: createOffGridApplication({
      models: models(),
      workspaceContent: new DesktopWorkspaceContentRepository(db),
      generatedImageGallery: gallery
    })
  }
}

describe('Workspace Content legacy order persistence', () => {
  it('converges opposite delivery order across two file-backed host restarts', async () => {
    directory = mkdtempSync(join(tmpdir(), 'offgrid-legacy-order-'))
    const paths = [join(directory, 'left.sqlite'), join(directory, 'right.sqlite')]
    const orders = [
      ['legacy-z', 'modern', 'legacy-a'],
      ['modern', 'legacy-a', 'legacy-z']
    ]
    for (const [index, path] of paths.entries()) {
      let runtime = open(path)
      await runtime.root.start()
      await runtime.root.workspaceContent.execute({
        type: 'create_conversation',
        conversationId: 'conversation',
        title: 'Legacy',
        createdAt: timestamp,
        updatedAt: timestamp,
        origin: 'remote'
      })
      for (const id of orders[index] ?? []) {
        const modern = id === 'modern'
        const outcome = await runtime.root.workspaceContent.execute({
          type: 'append_message',
          conversationId: 'conversation',
          messageId: id,
          portable: { role: 'assistant', content: id },
          turnId: null,
          ...(modern ? { position: 0 } : {}),
          createdAt: timestamp,
          updatedAt: timestamp,
          origin: 'remote'
        })
        expect(outcome, JSON.stringify(outcome)).toMatchObject({ ok: true })
      }
      await runtime.root.stop()
      runtime.db.close()
      runtime = open(path)
      await runtime.root.start()
      expect(
        runtime.root.workspaceContent
          .snapshot()
          .messages.every(({ orderToken }) => orderToken !== undefined)
      ).toBe(true)
      expect(
        runtime.root.workspaceContent.snapshot().messages.map(({ id, position }) => [id, position])
      ).toEqual([
        ['modern', 0],
        ['legacy-a', 1],
        ['legacy-z', 2]
      ])
      await runtime.root.workspaceContent.execute({
        type: 'append_message',
        conversationId: 'conversation',
        portable: { role: 'user', content: 'local' }
      })
      expect(
        await runtime.root.workspaceContent.execute({
          type: 'update_message',
          messageId: 'legacy-a',
          conversationId: 'conversation',
          portable: { role: 'assistant', content: 'replay' },
          turnId: null,
          createdAt: timestamp,
          updatedAt: timestamp,
          origin: 'remote'
        })
      ).toMatchObject({ ok: true })
      expect(
        runtime.root.workspaceContent.snapshot().messages.map(({ id, position }) => [id, position])
      ).toEqual([
        ['modern', 0],
        ['legacy-a', 1],
        ['legacy-z', 2],
        [expect.any(String), 3]
      ])
      await runtime.root.stop()
      runtime.db.close()
    }
  })
})
