import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3-multiple-ciphers'
import { afterEach, describe, expect, it } from 'vitest'
import type { GeneratedImageRecord } from '@offgrid/application'
import { DesktopGeneratedImageGalleryRepository } from '../imagegen/gallery-repository'
import { dataDir } from '../runtime-env'
import { initializeWorkspaceContentSchema } from '../workspace-content/schema'

let directory: string | undefined
let db: Database.Database | undefined

afterEach(() => {
  db?.close()
  db = undefined
  if (directory) fs.rmSync(directory, { recursive: true, force: true })
  directory = undefined
})

function image(id: string, conversationId: string, imageDirectory: string): GeneratedImageRecord {
  return {
    id,
    contentId: id,
    conversationId,
    prompt: id,
    width: 1,
    height: 1,
    steps: 1,
    seed: 1,
    modelId: 'test-model',
    createdAt: '2026-09-09T00:00:00.000Z',
    local: { path: path.join(imageDirectory, `${id}.png`), fileName: `${id}.png` }
  }
}

describe('generated-image gallery conversation deletion', () => {
  it('removes captured images in stages while rejecting new images for the deleting conversation', async () => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-gallery-deletion-'))
    db = new Database(path.join(directory, 'app.db'))
    initializeWorkspaceContentSchema(db)
    const repository = new DesktopGeneratedImageGalleryRepository(db)
    const configuredImageDirectory = path.join(dataDir(), 'generated-images')
    fs.mkdirSync(configuredImageDirectory, { recursive: true })
    const imageDirectory = fs.realpathSync.native(configuredImageDirectory)
    const conversationId = 'conversation'
    const first = image('first', conversationId, imageDirectory)
    const second = image('second', conversationId, imageDirectory)

    db.prepare(
      `INSERT INTO workspace_content_conversations
       (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)`
    ).run(conversationId, 'Deleting conversation', first.createdAt, first.createdAt)
    await expect(
      repository.replace({ expectedRevision: '0', images: [first, second] })
    ).resolves.toBe(true)

    db.prepare(
      `INSERT INTO workspace_content_conversation_deletion_intents
       (conversation_id, state, phase, image_ids_json, attempt, updated_at)
       VALUES (?, 'running', 'generated_images', ?, 1, ?)`
    ).run(conversationId, JSON.stringify([first.id, second.id]), first.createdAt)

    await expect(repository.replace({ expectedRevision: '1', images: [second] })).resolves.toBe(
      true
    )
    await expect(
      repository.replace({
        expectedRevision: '2',
        images: [second, image('late', conversationId, imageDirectory)]
      })
    ).rejects.toThrow(`Conversation ${conversationId} is missing or being deleted.`)
  })
})
