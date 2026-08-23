// Real model-manager boundary for device-transferred models. Bytes are already in the receiving
// profile's models directory, exactly as the Pro transfer owner leaves them after checksum
// verification; this proves registration makes them installed, transferable again, and protected.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

const originalDataDir = process.env.OFFGRID_DATA_DIR
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-model-transfer-registration-'))
process.env.OFFGRID_DATA_DIR = dataDir

const manager = await import('../../models-manager')
const downloaded = await import('../../downloaded-models')

function validGguf(marker: number): Buffer {
  return Buffer.concat([Buffer.from('GGUF', 'ascii'), Buffer.alloc(2_048, marker)])
}

beforeAll(() => {
  fs.mkdirSync(path.join(dataDir, 'models'), { recursive: true })
})

afterAll(() => {
  if (originalDataDir === undefined) delete process.env.OFFGRID_DATA_DIR
  else process.env.OFFGRID_DATA_DIR = originalDataDir
  fs.rmSync(dataDir, { recursive: true, force: true })
})

describe('device-transferred model registration', () => {
  it('registers a valid vision variant whose files differ from the download catalog', async () => {
    const primary = 'Qwen3.5-0.8B-Q4_0.gguf'
    const projector = 'qwen3.5-0.8b-mmproj-F16.gguf'
    const primaryBytes = validGguf(3)
    const projectorBytes = validGguf(4)
    fs.writeFileSync(path.join(dataDir, 'models', primary), primaryBytes)
    fs.writeFileSync(path.join(dataDir, 'models', projector), projectorBytes)

    const result = await manager.registerTransferredModel({
      id: 'unsloth/Qwen3.5-0.8B-GGUF',
      name: 'Qwen3.5 0.8B',
      kind: 'vision',
      source: 'downloaded',
      files: [
        { name: primary, sizeBytes: primaryBytes.length },
        { name: projector, sizeBytes: projectorBytes.length }
      ]
    })

    expect(result.success).toBe(true)
    expect(result.id).toMatch(/^model-package-v1:[0-9a-f]{64}$/)
    expect(await manager.listInstalled()).toContain(result.id)
    expect(await manager.getTransferableModel(result.id!)).toMatchObject({
      id: result.id,
      familyId: 'unsloth/Qwen3.5-0.8B-GGUF',
      packageIdentity: result.id,
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
    const other = await manager.registerTransferredModel({
      id: 'unsloth/Qwen3.5-0.8B-GGUF',
      name: 'Qwen3.5 0.8B',
      kind: 'vision',
      source: 'downloaded',
      files: [
        { name: otherPrimary, sizeBytes: otherBytes.length },
        { name: projector, sizeBytes: projectorBytes.length }
      ]
    })
    expect(other.success).toBe(true)
    expect(other.id).not.toBe(result.id)
    expect(await manager.listInstalled()).toEqual(expect.arrayContaining([result.id, other.id]))
  })

  it('registers a verified multi-file model through the production catalog owner', async () => {
    const primary = 'shared-model-q4.gguf'
    const projector = 'mmproj-shared-model-f16.gguf'
    const primaryBytes = validGguf(1)
    const projectorBytes = validGguf(2)
    fs.writeFileSync(path.join(dataDir, 'models', primary), primaryBytes)
    fs.writeFileSync(path.join(dataDir, 'models', projector), projectorBytes)

    const result = await manager.registerTransferredModel({
      id: 'off-grid/test-shared-model',
      name: 'Test shared model',
      kind: 'vision',
      source: 'downloaded',
      files: [
        { name: primary, sizeBytes: primaryBytes.length },
        { name: projector, sizeBytes: projectorBytes.length }
      ]
    })

    expect(result.success).toBe(true)
    expect(result.id).toMatch(/^model-package-v1:[0-9a-f]{64}$/)
    expect(await manager.listInstalled()).toContain(result.id)
    expect((await manager.getStorageInfo()).orphans).toEqual([])
    expect(await manager.getTransferableModel(result.id!)).toMatchObject({
      id: result.id,
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

    const register = (
      primary: string,
      bytes: Buffer
    ): ReturnType<typeof manager.registerTransferredModel> =>
      manager.registerTransferredModel({
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
    expect(first.success).toBe(true)
    expect(second.success).toBe(true)

    expect(await manager.deleteModel(first.id!)).toEqual({ success: true, freedFiles: 1 })
    expect(fs.existsSync(path.join(dataDir, 'models', firstPrimary))).toBe(false)
    expect(fs.existsSync(path.join(dataDir, 'models', sharedProjector))).toBe(true)
    expect(await manager.listInstalled()).not.toContain(first.id)
    expect(await manager.listInstalled()).toContain(second.id)

    expect(await manager.deleteModel(second.id!)).toEqual({ success: true, freedFiles: 2 })
    expect(fs.existsSync(path.join(dataDir, 'models', secondPrimary))).toBe(false)
    expect(fs.existsSync(path.join(dataDir, 'models', sharedProjector))).toBe(false)
    expect(await manager.listInstalled()).not.toContain(second.id)
  })

  it('rejects traversal and corrupt GGUF manifests without registering them', async () => {
    expect(
      await manager.registerTransferredModel({
        id: 'off-grid/traversal',
        name: 'Traversal',
        kind: 'text',
        source: 'downloaded',
        files: [{ name: '../outside.gguf', sizeBytes: 2_052 }]
      })
    ).toEqual({ success: false, error: 'model manifest contains an invalid file' })

    const corrupt = 'corrupt.gguf'
    fs.writeFileSync(path.join(dataDir, 'models', corrupt), Buffer.from('GGUF'))
    expect(
      await manager.registerTransferredModel({
        id: 'off-grid/corrupt',
        name: 'Corrupt',
        kind: 'text',
        source: 'downloaded',
        files: [{ name: corrupt, sizeBytes: 4 }]
      })
    ).toEqual({
      success: false,
      error: 'corrupt.gguf: transferred file is not a valid GGUF model'
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
      await manager.registerTransferredModel({
        id: 'off-grid/linked',
        name: 'Linked',
        kind: 'text',
        source: 'downloaded',
        files: [{ name: linked, sizeBytes: bytes.length }]
      })
    ).toEqual({
      success: false,
      error: 'linked.gguf: transferred file is not a regular file'
    })
    expect(await manager.getTransferableModel('off-grid/linked')).toBeNull()
  })
})
