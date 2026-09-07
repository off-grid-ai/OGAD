// Real model-manager boundary for device-transferred models. Bytes are already in the receiving
// profile's models directory, exactly as the Pro transfer owner leaves them after checksum
// verification; this proves registration makes them installed, transferable again, and protected.
import { afterAll, beforeAll, describe, expect, it, assert } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import type { TransferredModelManifest } from '@offgrid/sync'
import type { TransferableModelSource } from '@offgrid/models'

const originalDataDir = process.env.OFFGRID_DATA_DIR
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-model-transfer-registration-'))
process.env.OFFGRID_DATA_DIR = dataDir

const { desktopModelWorkspacePorts } = await import('../../model-services')
const { createOffGridApplication } = await import('@offgrid/application')
const { registerDesktopApplication } = await import('../../composition/application-access')
const { createDesktopModelTransferQueryPorts } = await import('../model-transfer-query-ports')
const manager = await import('../../models-manager')
const downloaded = await import('../../downloaded-models')
const application = createOffGridApplication({
  models: {
    ...desktopModelWorkspacePorts,
    activation: { resolve: manager.resolveDesktopActivation },
    library: {
      ...manager.desktopModelLibraryPorts,
      transferable: createDesktopModelTransferQueryPorts()
    }
  }
})
registerDesktopApplication(application)
const registerTransfer = (
  manifest: TransferredModelManifest
): ReturnType<typeof application.models.registerTransfer> =>
  application.models.registerTransfer({ manifest, expectedLibraryId: path.join(dataDir, 'models') })
async function transferable(modelId: string): Promise<TransferableModelSource | null> {
  const result = await application.models.transferableModels.resolve(modelId)
  assert(result.ok, JSON.stringify(result))
  return result.value
}

function validGguf(marker: number): Buffer {
  return Buffer.concat([Buffer.from('GGUF', 'ascii'), Buffer.alloc(2_048, marker)])
}

beforeAll(() => {
  fs.mkdirSync(path.join(dataDir, 'models'), { recursive: true })
})

afterAll(async () => {
  await application.stop()
  if (originalDataDir === undefined) delete process.env.OFFGRID_DATA_DIR
  else process.env.OFFGRID_DATA_DIR = originalDataDir
  fs.rmSync(dataDir, { recursive: true, force: true })
})

describe('device-transferred model registration', () => {
  it('activates a transferred Whisper package as transcription, not as the chat LLM', async () => {
    const primary = 'ggml-small.en.gguf'
    const primaryBytes = validGguf(10)
    fs.writeFileSync(path.join(dataDir, 'models', primary), primaryBytes)

    const registered = await registerTransfer({
      id: 'ggerganov/whisper.cpp/small.en',
      name: 'Whisper Small English',
      kind: 'transcription',
      source: 'downloaded',
      files: [{ name: primary, sizeBytes: primaryBytes.length }]
    })

    assert(registered.ok, JSON.stringify(registered))
    await expect(manager.activateModel(registered.value.modelId)).resolves.toEqual({
      success: true
    })
    expect(manager.getActiveModalities()).toMatchObject({ transcription: registered.value.modelId })
    expect(manager.getActiveModel()).not.toBe(registered.value.modelId)
  })

  it('registers a valid vision variant whose files differ from the download catalog', async () => {
    const primary = 'Qwen3.5-0.8B-Q4_0.gguf'
    const projector = 'qwen3.5-0.8b-mmproj-F16.gguf'
    const primaryBytes = validGguf(3)
    const projectorBytes = validGguf(4)
    fs.writeFileSync(path.join(dataDir, 'models', primary), primaryBytes)
    fs.writeFileSync(path.join(dataDir, 'models', projector), projectorBytes)

    const result = await registerTransfer({
      id: 'unsloth/Qwen3.5-0.8B-GGUF',
      name: 'Qwen3.5 0.8B',
      kind: 'vision',
      source: 'downloaded',
      files: [
        { name: primary, sizeBytes: primaryBytes.length },
        { name: projector, sizeBytes: projectorBytes.length }
      ]
    })

    assert(result.ok, JSON.stringify(result))
    expect(result.value.modelId).toMatch(/^model-package-v1:[0-9a-f]{64}$/)
    expect(await manager.listInstalled()).toContain(result.value.modelId)
    expect(await transferable(result.value.modelId)).toMatchObject({
      id: result.value.modelId,
      familyId: 'unsloth/Qwen3.5-0.8B-GGUF',
      packageIdentity: result.value.modelId,
      kind: 'vision',
      source: 'downloaded',
      files: [
        { name: primary, sizeBytes: primaryBytes.length },
        { name: projector, sizeBytes: projectorBytes.length }
      ]
    })

    const otherPrimary = 'Qwen3.5-0.8B-Q5_K_M.gguf'
    const otherBytes = validGguf(5)
    fs.writeFileSync(path.join(dataDir, 'models', otherPrimary), otherBytes)
    const other = await registerTransfer({
      id: 'unsloth/Qwen3.5-0.8B-GGUF',
      name: 'Qwen3.5 0.8B',
      kind: 'vision',
      source: 'downloaded',
      files: [
        { name: otherPrimary, sizeBytes: otherBytes.length },
        { name: projector, sizeBytes: projectorBytes.length }
      ]
    })
    assert(other.ok, JSON.stringify(other))
    expect(other.value.modelId).not.toBe(result.value.modelId)
    expect(await manager.listInstalled()).toEqual(
      expect.arrayContaining([result.value.modelId, other.value.modelId])
    )
  })

  it('reports active-projector finalization failure and repairs it on an idempotent retry', async () => {
    const primary = 'finalization-retry-q4.gguf'
    const projector = 'finalization-retry-mmproj-f16.gguf'
    const primaryBytes = validGguf(12)
    const projectorBytes = validGguf(13)
    const manifest: TransferredModelManifest = {
      id: 'off-grid/finalization-retry',
      name: 'Finalization retry',
      kind: 'vision',
      source: 'downloaded' as const,
      files: [
        { name: primary, sizeBytes: primaryBytes.length },
        { name: projector, sizeBytes: projectorBytes.length }
      ]
    }
    const { modelPackageIdentity } = await import('@offgrid/sync')
    const packageId = modelPackageIdentity(manifest)
    const activePath = path.join(dataDir, 'models', 'active-model.json')
    fs.writeFileSync(path.join(dataDir, 'models', primary), primaryBytes)
    fs.writeFileSync(path.join(dataDir, 'models', projector), projectorBytes)
    fs.writeFileSync(activePath, JSON.stringify({ id: packageId, primary, mmproj: null }))
    fs.chmodSync(activePath, 0o400)

    const failed = await registerTransfer(manifest)

    expect(failed).toEqual({
      ok: false,
      failure: {
        kind: 'runtime',
        message:
          'Model files are ready, but the active vision model could not be updated. Retry to finish setup.'
      }
    })
    expect(await manager.listInstalled()).toContain(packageId)
    expect(JSON.parse(fs.readFileSync(activePath, 'utf8')).mmproj).toBeNull()

    fs.chmodSync(activePath, 0o600)
    await expect(registerTransfer(manifest)).resolves.toEqual({
      ok: true,
      value: { modelId: packageId }
    })
    expect(JSON.parse(fs.readFileSync(activePath, 'utf8')).mmproj).toBe(projector)
  })

  it('registers a verified multi-file model through the production catalog owner', async () => {
    const primary = 'shared-model-q4.gguf'
    const projector = 'mmproj-shared-model-f16.gguf'
    const primaryBytes = validGguf(1)
    const projectorBytes = validGguf(2)
    fs.writeFileSync(path.join(dataDir, 'models', primary), primaryBytes)
    fs.writeFileSync(path.join(dataDir, 'models', projector), projectorBytes)

    const result = await registerTransfer({
      id: 'off-grid/test-shared-model',
      name: 'Test shared model',
      kind: 'vision',
      source: 'downloaded',
      files: [
        { name: primary, sizeBytes: primaryBytes.length },
        { name: projector, sizeBytes: projectorBytes.length }
      ]
    })

    assert(result.ok, JSON.stringify(result))
    expect(result.value.modelId).toMatch(/^model-package-v1:[0-9a-f]{64}$/)
    expect(await manager.listInstalled()).toContain(result.value.modelId)
    expect((await manager.getStorageInfo()).orphans).toEqual([])
    expect(await transferable(result.value.modelId)).toMatchObject({
      id: result.value.modelId,
      familyId: 'off-grid/test-shared-model',
      name: 'Test shared model',
      kind: 'vision',
      source: 'downloaded',
      files: [
        { name: primary, sizeBytes: primaryBytes.length },
        { name: projector, sizeBytes: projectorBytes.length }
      ]
    })
  })

  it('deletes the selected transferred variant and keeps files owned by a sibling variant', async () => {
    const sharedProjector = 'mmproj-delete-family-f16.gguf'
    const firstPrimary = 'delete-family-q4_0.gguf'
    const secondPrimary = 'delete-family-q5_k_m.gguf'
    const projectorBytes = validGguf(6)
    const firstBytes = validGguf(7)
    const secondBytes = validGguf(8)
    fs.writeFileSync(path.join(dataDir, 'models', sharedProjector), projectorBytes)
    fs.writeFileSync(path.join(dataDir, 'models', firstPrimary), firstBytes)
    fs.writeFileSync(path.join(dataDir, 'models', secondPrimary), secondBytes)

    const register = (primary: string, bytes: Buffer): ReturnType<typeof registerTransfer> =>
      registerTransfer({
        id: 'off-grid/delete-family',
        name: 'Delete family',
        kind: 'vision',
        source: 'downloaded',
        files: [
          { name: primary, sizeBytes: bytes.length },
          { name: sharedProjector, sizeBytes: projectorBytes.length }
        ]
      })
    const first = await register(firstPrimary, firstBytes)
    const second = await register(secondPrimary, secondBytes)
    assert(first.ok, JSON.stringify(first))
    assert(second.ok, JSON.stringify(second))

    expect(await manager.deleteModel(first.value.modelId)).toEqual({ success: true, freedFiles: 1 })
    expect(fs.existsSync(path.join(dataDir, 'models', firstPrimary))).toBe(false)
    expect(fs.existsSync(path.join(dataDir, 'models', sharedProjector))).toBe(true)
    expect(await manager.listInstalled()).not.toContain(first.value.modelId)
    expect(await manager.listInstalled()).toContain(second.value.modelId)

    expect(await manager.deleteModel(second.value.modelId)).toEqual({
      success: true,
      freedFiles: 2
    })
    expect(fs.existsSync(path.join(dataDir, 'models', secondPrimary))).toBe(false)
    expect(fs.existsSync(path.join(dataDir, 'models', sharedProjector))).toBe(false)
    expect(await manager.listInstalled()).not.toContain(second.value.modelId)
  })

  it('rejects traversal and corrupt GGUF manifests without registering them', async () => {
    expect(
      await registerTransfer({
        id: 'off-grid/traversal',
        name: 'Traversal',
        kind: 'text',
        source: 'downloaded',
        files: [{ name: '../outside.gguf', sizeBytes: 2_052 }]
      })
    ).toEqual({
      ok: false,
      failure: { kind: 'runtime', message: 'model manifest contains an invalid file' }
    })

    const corrupt = 'corrupt.gguf'
    fs.writeFileSync(path.join(dataDir, 'models', corrupt), Buffer.from('GGUF'))
    expect(
      await registerTransfer({
        id: 'off-grid/corrupt',
        name: 'Corrupt',
        kind: 'text',
        source: 'downloaded',
        files: [{ name: corrupt, sizeBytes: 4 }]
      })
    ).toEqual({
      ok: false,
      failure: {
        kind: 'runtime',
        message: 'corrupt.gguf: transferred file is not a valid GGUF model'
      }
    })
    expect(await manager.listInstalled()).not.toContain('off-grid/corrupt')
  })

  it('rejects symlinked model bytes for both sending and receiving', async () => {
    const outside = path.join(dataDir, 'outside.gguf')
    const linked = 'linked.gguf'
    const bytes = validGguf(9)
    fs.writeFileSync(outside, bytes)
    fs.symlinkSync(outside, path.join(dataDir, 'models', linked))
    downloaded.recordDownloaded(path.join(dataDir, 'models'), {
      id: 'off-grid/linked',
      name: 'Linked',
      kind: 'text',
      files: [linked]
    })

    expect(
      await registerTransfer({
        id: 'off-grid/linked',
        name: 'Linked',
        kind: 'text',
        source: 'downloaded',
        files: [{ name: linked, sizeBytes: bytes.length }]
      })
    ).toEqual({
      ok: false,
      failure: { kind: 'runtime', message: 'linked.gguf: transferred file is not a regular file' }
    })
    expect(await application.models.transferableModels.resolve('off-grid/linked')).toMatchObject({
      ok: false,
      failure: { kind: 'invalid_artifact' }
    })
  })
})
