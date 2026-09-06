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
import type { OffGridApplication } from '@offgrid/application'
import { CATALOG, primaryFileName } from '@offgrid/models'

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

const IMAGE_MODEL_ID = 'mzwing/SDXL-Lightning-GGUF'
const IMAGE_MODEL = primaryFileName(CATALOG.find((model) => model.id === IMAGE_MODEL_ID)!)!
const CONVERSATION_ID = '11111111-1111-4111-8111-111111111111'
const MESSAGE_ID = '22222222-2222-4222-8222-222222222222'
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='

let jobs: typeof import('../imagegen/job-service').imageGenerationJobs
let application: OffGridApplication | undefined
let releaseApplication: (() => void) | undefined

beforeAll(async () => {
  process.env.OFFGRID_DATA_DIR = fixture.dataDir
  process.env.OFFGRID_BIN_DIR = fixture.binDir
  vi.spyOn(os, 'totalmem').mockReturnValue(64_000_000_000)
  vi.spyOn(os, 'freemem').mockReturnValue(48_000_000_000)
  const models = path.join(fixture.dataDir, 'models')
  fs.mkdirSync(models, { recursive: true })
  fs.writeFileSync(
    path.join(models, IMAGE_MODEL),
    'GGUF fixture first_stage_model cond_stage_model'
  )
  fs.writeFileSync(
    path.join(models, 'active-modalities.json'),
    JSON.stringify({ image: IMAGE_MODEL_ID })
  )

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

  const [database, applicationModule, applicationAccess, modelServices] = await Promise.all([
    import('../database'),
    import('@offgrid/application'),
    import('../composition/application-access'),
    import('../model-services')
  ])
  database.saveSetting('enhanceImagePrompts', false)
  application = applicationModule.createOffGridApplication({
    models: modelServices.desktopModelWorkspacePorts
  })
  releaseApplication = applicationAccess.registerDesktopApplication(application)
  await application.start()
  jobs = (await import('../imagegen/job-service')).imageGenerationJobs
})

afterAll(async () => {
  await application?.stop()
  releaseApplication?.()
  vi.restoreAllMocks()
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
      model: IMAGE_MODEL_ID,
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

    const refreshed: string[] = []
    const detachRefresh = jobs.onConversationUpdated((conversationId) =>
      refreshed.push(conversationId)
    )
    expect(jobs.acknowledgeConversation(CONVERSATION_ID, MESSAGE_ID)).toBe(true)
    expect(refreshed).toEqual([CONVERSATION_ID])
    detachRefresh()
    detachReturned()
  }, 15_000)
})
