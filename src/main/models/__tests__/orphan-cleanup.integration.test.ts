import { afterAll, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const originalDataDir = process.env.OFFGRID_DATA_DIR
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-orphan-cleanup-'))
process.env.OFFGRID_DATA_DIR = dataDir

await import('../../model-services')
const manager = await import('../../models-manager')

afterAll(() => {
  if (originalDataDir === undefined) delete process.env.OFFGRID_DATA_DIR
  else process.env.OFFGRID_DATA_DIR = originalDataDir
  fs.rmSync(dataDir, { recursive: true, force: true })
})

describe('orphan cleanup partial failure', () => {
  it('stops cleanup when active model metadata is corrupt', async () => {
    const modelsDir = path.join(dataDir, 'models')
    fs.mkdirSync(modelsDir, { recursive: true })
    const retained = path.join(modelsDir, 'active-but-unreadable.gguf')
    const activeFile = path.join(modelsDir, 'active-model.json')
    fs.writeFileSync(retained, Buffer.alloc(1024))
    fs.writeFileSync(activeFile, '{}')

    await expect(manager.deleteOrphans()).rejects.toMatchObject({
      name: 'ActiveModelMetadataError',
      code: 'ACTIVE_MODEL_METADATA_CORRUPT',
      filePath: activeFile
    })
    expect(fs.existsSync(retained)).toBe(true)

    fs.rmSync(activeFile, { force: true })
    fs.rmSync(retained, { force: true })
  })

  it('stops cleanup when active model metadata cannot be read', async () => {
    const modelsDir = path.join(dataDir, 'models')
    fs.mkdirSync(modelsDir, { recursive: true })
    const retained = path.join(modelsDir, 'active-permission-denied.gguf')
    const activeFile = path.join(modelsDir, 'active-model.json')
    fs.writeFileSync(retained, Buffer.alloc(1024))
    fs.writeFileSync(
      activeFile,
      JSON.stringify({ id: 'active', primary: path.basename(retained), mmproj: null })
    )
    const read = fs.readFileSync.bind(fs)
    const denied = Object.assign(new Error('permission denied'), { code: 'EACCES' })
    const spy = vi.spyOn(fs, 'readFileSync').mockImplementation(((file, options) => {
      if (String(file) === activeFile) throw denied
      return read(file, options as never)
    }) as typeof fs.readFileSync)

    try {
      await expect(manager.deleteOrphans()).rejects.toMatchObject({
        name: 'ModelSelectionPersistenceError',
        code: 'MODEL_SELECTION_READ_FAILED',
        filePath: activeFile
      })
      expect(fs.existsSync(retained)).toBe(true)
    } finally {
      spy.mockRestore()
      fs.rmSync(activeFile, { force: true })
      fs.rmSync(retained, { force: true })
    }
  })

  it('reports each retained file and its bytes instead of returning false success', async () => {
    const modelsDir = path.join(dataDir, 'models')
    fs.mkdirSync(modelsDir, { recursive: true })
    const removable = path.join(modelsDir, 'unused-removable.gguf')
    const retained = path.join(modelsDir, 'unused-retained.gguf')
    fs.writeFileSync(removable, Buffer.alloc(512))
    fs.writeFileSync(retained, Buffer.alloc(1024))

    const remove = fs.rmSync.bind(fs)
    const rm = vi.spyOn(fs, 'rmSync').mockImplementation((target, options) => {
      if (String(target) === retained) {
        throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' })
      }
      return remove(target, options)
    })

    const result = await manager.deleteOrphans()
    rm.mockRestore()

    expect(result).toEqual({
      success: false,
      count: 1,
      freedBytes: 512,
      retainedBytes: 1024,
      failures: [
        {
          name: 'unused-retained.gguf',
          bytes: 1024,
          error: 'EACCES: permission denied'
        }
      ]
    })
    expect(fs.existsSync(removable)).toBe(false)
    expect(fs.existsSync(retained)).toBe(true)
    expect((await manager.getStorageInfo()).orphans).toContainEqual({
      name: 'unused-retained.gguf',
      bytes: 1024
    })
  })
})
