/**
 * Release journey #133 - storage usage is derived from the real files and stores.
 *
 * Electron's userData directory and the native vector module are the only controlled
 * boundaries. Model accounting, filesystem traversal, SQLite-backed category counts,
 * and personal-data directory accounting all use the production owners.
 */
import { afterAll, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-storage-usage-'))
const originalDataDir = process.env.OFFGRID_DATA_DIR
process.env.OFFGRID_DATA_DIR = testRoot

vi.mock('electron', () => ({
  app: {
    getPath: () => testRoot,
    getAppPath: () => process.cwd(),
    isPackaged: false
  },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString()
  }
}))

// getDataSummary imports the vector owner, but storage accounting does not access
// the native vector database. Keep that uncontrollable native boundary inert.
vi.mock('@lancedb/lancedb', () => ({ connect: async () => ({}) }))

const database = await import('../database')
const { getDataSummary } = await import('../data-privacy')
const modelManager = await import('../models-manager')
const { CATALOG } = await import('@offgrid/models')

function writeFixture(relativePath: string, bytes: number): void {
  const target = path.join(testRoot, relativePath)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, Buffer.alloc(bytes, relativePath.length % 255))
}

afterAll(() => {
  database.getDB().close()
  if (originalDataDir === undefined) delete process.env.OFFGRID_DATA_DIR
  else process.env.OFFGRID_DATA_DIR = originalDataDir
  fs.rmSync(testRoot, { recursive: true, force: true })
})

describe('storage usage', () => {
  it('reports exact model totals and personal-data category sizes from disk', async () => {
    const catalogModel = CATALOG.find(
      (model) => model.files.length === 1 && model.files[0]?.name.endsWith('.gguf')
    )
    if (!catalogModel) throw new Error('Model catalog needs a single-file GGUF fixture')

    const primary = catalogModel.files[0]!.name
    writeFixture(path.join('models', primary), 6_144)
    writeFixture(path.join('models', 'unused.gguf'), 1_024)
    writeFixture(path.join('models', 'interrupted.gguf.part'), 512)
    writeFixture(path.join('models', 'ignored-metadata.json'), 32_768)

    writeFixture(path.join('captures', '2026-07-17', 'frame.png'), 2_048)
    writeFixture(path.join('meetings', 'meeting.wav'), 3_072)
    writeFixture(path.join('generated-images', 'render.png'), 4_096)
    writeFixture(path.join('artifacts-library', 'report.html'), 3_072)
    writeFixture(path.join('style-thumbs', 'style.png'), 1_024)

    const modelStorage = await modelManager.getStorageInfo()
    expect(modelStorage.dir).toBe(path.join(testRoot, 'models'))
    expect(modelStorage.totalBytes).toBe(6_144 + 1_024 + 512)
    expect(modelStorage.models).toContainEqual(
      expect.objectContaining({
        id: catalogModel.id,
        kind: catalogModel.kind,
        bytes: 6_144
      })
    )
    expect(modelStorage.orphans).toEqual(
      expect.arrayContaining([
        { name: 'unused.gguf', bytes: 1_024 },
        { name: 'interrupted.gguf.part', bytes: 512 }
      ])
    )
    expect(modelStorage.freeBytes).toBeGreaterThan(0)

    const categories = getDataSummary()
    expect(categories.find((category) => category.id === 'captures')).toMatchObject({
      count: 1,
      bytes: 2_048
    })
    expect(categories.find((category) => category.id === 'meetings')).toMatchObject({
      count: 1,
      bytes: 3_072
    })
    expect(categories.find((category) => category.id === 'images')).toMatchObject({
      count: 3,
      bytes: 8_192
    })
  })

  it('clears a download interrupted in an earlier session and keeps installed models', async () => {
    writeFixture(path.join('models', 'kept.gguf'), 2_048)
    writeFixture(path.join('models', 'earlier-session.gguf.part'), 1_536)
    fs.mkdirSync(path.join(testRoot, 'models', 'folder.part'), { recursive: true })

    const before = await modelManager.getStorageInfo()
    const result = await modelManager.clearInactiveDownloads()

    expect(result.success).toBe(true)
    expect(result.freedBytes).toBeGreaterThanOrEqual(1_536)
    expect(fs.existsSync(path.join(testRoot, 'models', 'earlier-session.gguf.part'))).toBe(false)
    expect(fs.existsSync(path.join(testRoot, 'models', 'kept.gguf'))).toBe(true)
    // Only files are incomplete transfers; a directory that happens to end in .part is left alone.
    expect(fs.existsSync(path.join(testRoot, 'models', 'folder.part'))).toBe(true)
    const after = await modelManager.getStorageInfo()
    expect(after.totalBytes).toBe(before.totalBytes - result.freedBytes)
  })
})
