/**
 * User journey: start an image, navigate away (detach the first renderer observer),
 * return (attach a second observer), and receive the same main-owned job/result.
 * Production image job service, imagegen, modality queue, settings, and filesystem
 * stay real. Only the bundled native sd-cli executable is controlled.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

const fixture = (() => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-image-navigation-'))
  return {
    root,
    dataDir: path.join(root, 'data'),
    binDir: path.join(root, 'bin')
  }
})()

vi.mock('electron', () => ({
  app: {
    getPath: () => fixture.dataDir,
    isPackaged: false,
    getAppPath: () => process.cwd(),
    getVersion: () => 'test'
  },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString()
  }
}))

const IMAGE_MODEL = 'navigation-image-fixture.safetensors'
const CONVERSATION_ID = '11111111-1111-4111-8111-111111111111'
const MESSAGE_ID = '22222222-2222-4222-8222-222222222222'
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='

let jobs: typeof import('../imagegen/job-service').imageGenerationJobs

beforeAll(async () => {
  process.env.OFFGRID_DATA_DIR = fixture.dataDir
  process.env.OFFGRID_BIN_DIR = fixture.binDir
  const models = path.join(fixture.dataDir, 'models')
  fs.mkdirSync(models, { recursive: true })
  fs.writeFileSync(path.join(models, IMAGE_MODEL), 'image checkpoint')

  const executable = path.join(fixture.binDir, 'sd', 'sd-cli')
  fs.mkdirSync(path.dirname(executable), { recursive: true })
  fs.writeFileSync(
    executable,
    `#!/usr/bin/env node
const fs = require('node:fs')
const args = process.argv.slice(2)
const output = args[args.indexOf('-o') + 1]
setTimeout(() => fs.writeFileSync(output, Buffer.from('${PNG_BASE64}', 'base64')), 350)
`
  )
  fs.chmodSync(executable, 0o755)

  const database = await import('../database')
  database.saveSetting('enhanceImagePrompts', false)
  jobs = (await import('../imagegen/job-service')).imageGenerationJobs
})

afterAll(async () => {
  const { getDB } = await import('../database')
  if (getDB().open) getDB().close()
  delete process.env.OFFGRID_DATA_DIR
  delete process.env.OFFGRID_BIN_DIR
  fs.rmSync(fixture.root, { recursive: true, force: true })
})

describe('image generation across feature navigation', () => {
  it('continues one native job while observers detach and reattach', async () => {
    const firstScreen: string[] = []
    const returnedScreen: string[] = []
    const detachFirst = jobs.onChange((job) => firstScreen.push(job.phase))

    const generation = jobs.start({
      prompt: 'A green cabin rendered while navigating',
      model: IMAGE_MODEL,
      conversationId: CONVERSATION_ID,
      projectId: 'project-navigation',
      seed: 91,
      width: 512,
      height: 512,
      steps: 4
    })
    expect(jobs.status()).toMatchObject({
      phase: 'running',
      conversationId: CONVERSATION_ID,
      projectId: 'project-navigation'
    })

    detachFirst()
    const detachReturned = jobs.onChange((job) => returnedScreen.push(job.phase))
    expect(jobs.status().phase).toBe('running')

    const image = await generation
    expect(image.dataUrl).toBe(`data:image/png;base64,${PNG_BASE64}`)
    expect(firstScreen).not.toContain('succeeded')
    expect(returnedScreen).toContain('succeeded')
    expect(jobs.status()).toMatchObject({
      phase: 'succeeded',
      conversationId: CONVERSATION_ID,
      outputPath: image.path
    })
    expect(JSON.parse(fs.readFileSync(`${image.path}.json`, 'utf8'))).toMatchObject({
      syncId: image.syncId,
      conversationId: CONVERSATION_ID
    })

    const refreshed: string[] = []
    const detachRefresh = jobs.onConversationUpdated((conversationId) =>
      refreshed.push(conversationId)
    )
    const { getDB } = await import('../database')
    getDB()
      .prepare(
        `INSERT INTO rag_conversations (id, title)
         VALUES (?, ?)`
      )
      .run(CONVERSATION_ID, 'Navigation image')
    getDB()
      .prepare(
        `INSERT INTO rag_messages (uuid, conversation_id, role, content)
         VALUES (?, ?, 'assistant', ?)`
      )
      .run(MESSAGE_ID, CONVERSATION_ID, 'Generated image')
    expect(
      jobs.acknowledgeConversation(CONVERSATION_ID, MESSAGE_ID)
    ).toBe(true)
    expect(refreshed).toEqual([CONVERSATION_ID])
    detachRefresh()
    detachReturned()
  }, 15_000)
})
