/**
 * The real Desktop composition root must exist before the early shell binds adapters to it.
 * The temporary Electron profile is the only boundary replacement; application construction,
 * facade proxies, and all three startup adapters are production code.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import sharp from 'sharp'
import { afterAll, describe, expect, it, vi } from 'vitest'

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-startup-adapters-'))
const originalDataDir = process.env.OFFGRID_DATA_DIR
const originalSkipCompatibleGenerationModel = process.env.OFFGRID_SKIP_COMPATIBLE_GENERATION_MODEL
process.env.OFFGRID_DATA_DIR = profile
process.env.OFFGRID_SKIP_COMPATIBLE_GENERATION_MODEL = '1'

const generatedImagesDirectory = path.join(profile, 'generated-images')
const legacyImagePath = path.join(generatedImagesDirectory, 'legacy-image.png')
const incompleteImagePath = path.join(generatedImagesDirectory, 'incomplete-image.png')
const orphanedImagePath = path.join(generatedImagesDirectory, 'orphaned-image.png')
const orphanedCopyPath = path.join(generatedImagesDirectory, 'orphaned-image-copy.png')
fs.mkdirSync(generatedImagesDirectory, { recursive: true })
for (const [index, imagePath] of [
  legacyImagePath,
  incompleteImagePath,
  orphanedImagePath
].entries()) {
  await sharp({
    create: {
      width: 1,
      height: 1,
      channels: 4,
      background: { r: index, g: 0, b: 0, alpha: 1 }
    }
  })
    .png()
    .toFile(imagePath)
}
fs.writeFileSync(
  `${legacyImagePath}.json`,
  JSON.stringify({
    width: 1,
    height: 1,
    metadataJson: JSON.stringify({ modelId: '', prompt: 'Legacy image', seed: 0, steps: 20 })
  })
)
fs.writeFileSync(
  `${incompleteImagePath}.json`,
  JSON.stringify({
    width: 1,
    height: 1,
    metadataJson: JSON.stringify({
      modelId: 'legacy-model',
      prompt: 'Incomplete',
      seed: 0,
      steps: 0
    })
  })
)
fs.writeFileSync(
  `${orphanedImagePath}.json`,
  JSON.stringify({
    syncId: 'orphaned-image',
    width: 1,
    height: 1,
    conversationId: 'deleted-conversation',
    messageId: 'deleted-message',
    metadataJson: JSON.stringify({
      modelId: 'legacy-model',
      prompt: 'Orphaned image',
      seed: 1,
      steps: 20
    })
  })
)
fs.copyFileSync(orphanedImagePath, orphanedCopyPath)
fs.copyFileSync(`${orphanedImagePath}.json`, `${orphanedCopyPath}.json`)

vi.mock('electron', () => ({
  app: {
    getPath: () => profile,
    getAppPath: () => process.cwd(),
    getVersion: () => 'test',
    isPackaged: false
  },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString()
  },
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: {
    on: vi.fn(),
    removeListener: vi.fn(),
    handle: vi.fn(),
    removeHandler: vi.fn()
  }
}))

const composition = await import('../composition/application')
const { desktopApplicationStatus } = await import('../composition/application-access')
const { setupRagIPC } = await import('../rag-ipc')
const { registerActionsIpc } = await import('../actions/actions-ipc')
const { registerTaskHistoryIpc } = await import('../tasks/task-history-ipc')
const { getDB } = await import('../database')

let releaseRag: (() => void) | null = null
let releaseActions: (() => void) | null = null

afterAll(async () => {
  releaseActions?.()
  releaseRag?.()
  await composition.stopDesktopApplication()
  if (getDB().open) getDB().close()
  if (originalDataDir === undefined) delete process.env.OFFGRID_DATA_DIR
  else process.env.OFFGRID_DATA_DIR = originalDataDir
  if (originalSkipCompatibleGenerationModel === undefined)
    delete process.env.OFFGRID_SKIP_COMPATIBLE_GENERATION_MODEL
  else process.env.OFFGRID_SKIP_COMPATIBLE_GENERATION_MODEL = originalSkipCompatibleGenerationModel
  fs.rmSync(profile, { recursive: true, force: true })
})

describe('Desktop adapters during early-shell startup', () => {
  it('binds every application-backed adapter before domain startup', () => {
    expect(desktopApplicationStatus()).toBe('created')

    expect(() => {
      releaseRag = setupRagIPC()
      releaseActions = registerActionsIpc()
      registerTaskHistoryIpc()
    }).not.toThrow()
  })

  it('starts without degrading when a legacy image has no model identifier', async () => {
    await composition.startDesktopApplication()

    expect(composition.desktopApplication.generatedImages?.snapshot().images).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          local: expect.objectContaining({ fileName: path.basename(legacyImagePath) }),
          modelId: 'legacy:unknown'
        }),
        expect.objectContaining({
          id: 'orphaned-image',
          conversationId: null,
          modelId: 'legacy-model'
        })
      ])
    )
    expect(composition.desktopApplication.snapshot().degraded).not.toContainEqual(
      expect.objectContaining({ source: 'desktop sidecar migration' })
    )
    expect(fs.existsSync(incompleteImagePath)).toBe(true)
  })
})
