import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { CATALOG } from '@offgrid/models'

const originalDataDir = process.env.OFFGRID_DATA_DIR
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-transferred-vision-'))
process.env.OFFGRID_DATA_DIR = dataDir

const manager = await import('../../models-manager')

const FAMILY_ID = 'unsloth/Qwen3.5-0.8B-GGUF'
const PRIMARY = 'Qwen3.5-0.8B-Q4_K_M.gguf'
const PROJECTOR = 'qwen3.5-0.8b-mmproj-F16.gguf'
const modelsDir = path.join(dataDir, 'models')

function validGguf(marker: number): Buffer {
  return Buffer.concat([Buffer.from('GGUF', 'ascii'), Buffer.alloc(2_048, marker)])
}

beforeAll(() => {
  fs.mkdirSync(modelsDir, { recursive: true })
})

afterAll(() => {
  if (originalDataDir === undefined) delete process.env.OFFGRID_DATA_DIR
  else process.env.OFFGRID_DATA_DIR = originalDataDir
  fs.rmSync(dataDir, { recursive: true, force: true })
})

describe('transferred vision variant activation', () => {
  it('migrates the legacy family alias and always activates the transferred projector', async () => {
    const catalog = CATALOG.find((model) => model.id === FAMILY_ID)
    expect(catalog).toBeDefined()
    const catalogPrimary = catalog!.files.find((file) => file.role === 'primary')!.name
    const catalogProjector = catalog!.files.find((file) => file.role === 'mmproj')!.name

    for (const [index, name] of [PRIMARY, PROJECTOR, catalogPrimary, catalogProjector].entries()) {
      fs.writeFileSync(path.join(modelsDir, name), validGguf(index + 1))
    }
    fs.writeFileSync(
      path.join(modelsDir, 'downloaded-models.json'),
      JSON.stringify([
        {
          id: FAMILY_ID,
          name: 'Qwen 3.5 0.8B',
          kind: 'vision',
          files: [PRIMARY, PROJECTOR]
        }
      ])
    )
    fs.writeFileSync(
      path.join(modelsDir, 'active-model.json'),
      JSON.stringify({ id: FAMILY_ID, primary: catalogPrimary, mmproj: catalogProjector })
    )

    const catalogView = (await manager.getCatalog()).models as Array<{
      id: string
      name: string
      files: Array<{ name: string; role?: string }>
    }>
    const registry = JSON.parse(
      fs.readFileSync(path.join(modelsDir, 'downloaded-models.json'), 'utf8')
    ) as Array<{ id: string; familyId?: string; packageIdentity?: string; files: string[] }>
    expect(registry).toHaveLength(1)
    expect(registry[0]).toMatchObject({
      id: expect.stringMatching(/^model-package-v1:[0-9a-f]{64}$/),
      familyId: FAMILY_ID,
      packageIdentity: expect.stringMatching(/^model-package-v1:[0-9a-f]{64}$/),
      files: [PRIMARY, PROJECTOR]
    })
    const exactId = registry[0]!.id
    expect(
      catalogView.filter((model) => model.id === FAMILY_ID || model.id === exactId).map((m) => m.id)
    ).toEqual([exactId])
    expect(catalogView.find((model) => model.id === exactId)?.files).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: PROJECTOR, role: 'mmproj' })])
    )
    expect(await manager.listInstalled()).toEqual(expect.arrayContaining([exactId]))
    expect(await manager.listInstalled()).not.toContain(FAMILY_ID)

    expect(await manager.reconcileActiveModelProjector()).toBe(true)
    expect(JSON.parse(fs.readFileSync(path.join(modelsDir, 'active-model.json'), 'utf8'))).toEqual({
      id: exactId,
      primary: PRIMARY,
      mmproj: PROJECTOR
    })
    expect(await manager.setActiveModel(FAMILY_ID)).toEqual({ success: true })
    expect(JSON.parse(fs.readFileSync(path.join(modelsDir, 'active-model.json'), 'utf8'))).toEqual({
      id: exactId,
      primary: PRIMARY,
      mmproj: PROJECTOR
    })
    expect(await manager.getVisionStatuses()).toMatchObject({
      [exactId]: { supportsVision: true, projectorInstalled: true }
    })

    // Registry reconciliation only changes metadata. It never deletes either transferred bytes or
    // older catalog bytes that may still be on disk.
    for (const name of new Set([PRIMARY, PROJECTOR, catalogPrimary, catalogProjector])) {
      expect(fs.existsSync(path.join(modelsDir, name))).toBe(true)
    }
  })
})
