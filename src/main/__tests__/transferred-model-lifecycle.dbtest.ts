import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it, assert } from 'vitest'
import { createFakeLocalTextRuntime } from './harness/local-text-runtime'

const originalDataDir = process.env.OFFGRID_DATA_DIR
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-transferred-lifecycle-'))
const modelsDir = path.join(dataDir, 'models')
let application: import('@offgrid/application').OffGridApplication | undefined

function validGguf(marker: number): Buffer {
  return Buffer.concat([Buffer.from('GGUF', 'ascii'), Buffer.alloc(2_048, marker)])
}

beforeAll(() => {
  process.env.OFFGRID_DATA_DIR = dataDir
  fs.mkdirSync(modelsDir, { recursive: true })
})

afterAll(async () => {
  await application?.stop()
  if (originalDataDir === undefined) delete process.env.OFFGRID_DATA_DIR
  else process.env.OFFGRID_DATA_DIR = originalDataDir
  fs.rmSync(dataDir, { recursive: true, force: true })
})

describe('transferred model lifecycle', () => {
  it('registers, activates, offers, protects, and deletes one exact vision package', async () => {
    const manager = await import('../models-manager')
    const { createDesktopModelWorkspacePorts } = await import('../model-services')
    const { createOffGridApplication } = await import('@offgrid/application')
    const { registerDesktopApplication } = await import('../composition/application-access')
    const { createDesktopModelTransferQueryPorts } =
      await import('../models/model-transfer-query-ports')
    const workspace = createDesktopModelWorkspacePorts({
      listCatalog: async () =>
        (await manager.getCatalog()).models as Awaited<
          ReturnType<
            Parameters<typeof createDesktopModelWorkspacePorts>[0]['listCatalog']
          >
        >,
      listInstalled: () => manager.listInstalled(),
      installedArtifactBytes: (fileName) => {
        try {
          const entry = fs.statSync(path.join(modelsDir, fileName))
          return entry.isFile() ? entry.size : undefined
        } catch {
          return undefined
        }
      },
      localTextRuntime: createFakeLocalTextRuntime().runtime,
      projectTextSelection: async () => ({ success: true })
    })
    application = createOffGridApplication({
      models: {
        ...workspace,
        activation: { resolve: manager.resolveDesktopActivation },
        library: {
          ...manager.desktopModelLibraryPorts,
          transferable: createDesktopModelTransferQueryPorts()
        }
      }
    })
    registerDesktopApplication(application)
    const familyId = 'off-grid/db-vision-family'
    const primary = 'db-vision-q4.gguf'
    const projector = 'mmproj-db-vision-f16.gguf'
    const primaryBytes = validGguf(1)
    const projectorBytes = validGguf(2)
    fs.writeFileSync(path.join(modelsDir, primary), primaryBytes)
    fs.writeFileSync(path.join(modelsDir, projector), projectorBytes)

    const registered = await application.models.registerTransfer({
      expectedLibraryId: modelsDir,
      manifest: {
        id: familyId,
        name: 'DB vision package',
        kind: 'text',
        source: 'downloaded',
        files: [
          { name: primary, sizeBytes: primaryBytes.length, role: 'primary' },
          { name: projector, sizeBytes: projectorBytes.length, role: 'projector' }
        ]
      }
    })

    assert(registered.ok, JSON.stringify(registered))
    expect(registered.value.modelId).toMatch(/^model-package-v1:[0-9a-f]{64}$/)
    const packageId = registered.value.modelId
    expect(await manager.listInstalled()).toContain(packageId)
    expect((await manager.getCatalog()).models).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: packageId, kind: 'vision' })])
    )
    expect(await manager.getVisionStatuses()).toMatchObject({
      [packageId]: { supportsVision: true, projectorInstalled: true }
    })
    const offered = await application.models.transferableModels.resolve(familyId)
    assert(offered.ok, JSON.stringify(offered))
    expect(offered.value).toMatchObject({
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

    // Selection targets the exact identity returned by registration, not a registry family alias.
    expect(await manager.setActiveModel(packageId)).toEqual({ success: true })
    expect(manager.getActiveModalities().text).toBe(packageId)
    expect(await manager.reconcileActiveModelProjector()).toBe(false)

    expect(await manager.deleteModel(packageId)).toEqual({ success: true, freedFiles: 2 })
    expect(manager.getActiveModalities().text).toBeNull()
    expect(await manager.listInstalled()).not.toContain(packageId)
    expect(fs.existsSync(path.join(modelsDir, primary))).toBe(false)
    expect(fs.existsSync(path.join(modelsDir, projector))).toBe(false)
  })
})
