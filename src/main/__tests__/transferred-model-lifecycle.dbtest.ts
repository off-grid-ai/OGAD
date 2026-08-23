import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const originalDataDir = process.env.OFFGRID_DATA_DIR
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-transferred-lifecycle-'))
const modelsDir = path.join(dataDir, 'models')

function validGguf(marker: number): Buffer {
  return Buffer.concat([Buffer.from('GGUF', 'ascii'), Buffer.alloc(2_048, marker)])
}

beforeAll(() => {
  process.env.OFFGRID_DATA_DIR = dataDir
  fs.mkdirSync(modelsDir, { recursive: true })
})

afterAll(() => {
  if (originalDataDir === undefined) delete process.env.OFFGRID_DATA_DIR
  else process.env.OFFGRID_DATA_DIR = originalDataDir
  fs.rmSync(dataDir, { recursive: true, force: true })
})

describe('transferred model lifecycle', () => {
  it('registers, activates, offers, protects, and deletes one exact vision package', async () => {
    const manager = await import('../models-manager')
    const familyId = 'off-grid/db-vision-family'
    const primary = 'db-vision-q4.gguf'
    const projector = 'mmproj-db-vision-f16.gguf'
    const primaryBytes = validGguf(1)
    const projectorBytes = validGguf(2)
    fs.writeFileSync(path.join(modelsDir, primary), primaryBytes)
    fs.writeFileSync(path.join(modelsDir, projector), projectorBytes)

    const registered = await manager.registerTransferredModel({
      id: familyId,
      name: 'DB vision package',
      kind: 'text',
      source: 'downloaded',
      files: [
        { name: primary, sizeBytes: primaryBytes.length, role: 'primary' },
        { name: projector, sizeBytes: projectorBytes.length, role: 'projector' }
      ]
    })

    expect(registered).toMatchObject({ success: true })
    expect(registered.id).toMatch(/^model-package-v1:[0-9a-f]{64}$/)
    const packageId = registered.id!
    expect(await manager.listInstalled()).toContain(packageId)
    expect((await manager.getCatalog()).models).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: packageId, kind: 'vision' })])
    )
    expect(await manager.getVisionStatuses()).toMatchObject({
      [packageId]: { supportsVision: true, projectorInstalled: true }
    })
    expect(await manager.getTransferableModel(familyId)).toMatchObject({
      id: packageId,
      familyId,
      packageIdentity: packageId,
      kind: 'vision',
      files: [
        { name: primary, sizeBytes: primaryBytes.length },
        { name: projector, sizeBytes: projectorBytes.length }
      ]
    })
    expect((await manager.getStorageInfo()).orphans).toEqual([])

    expect(await manager.setActiveModel(familyId)).toEqual({ success: true })
    expect(manager.getActiveModalities().text).toBe(packageId)
    expect(await manager.reconcileActiveModelProjector()).toBe(false)

    expect(await manager.deleteModel(familyId)).toEqual({ success: true, freedFiles: 2 })
    expect(manager.getActiveModalities().text).toBeNull()
    expect(await manager.listInstalled()).not.toContain(packageId)
    expect(fs.existsSync(path.join(modelsDir, primary))).toBe(false)
    expect(fs.existsSync(path.join(modelsDir, projector))).toBe(false)
  })
})
