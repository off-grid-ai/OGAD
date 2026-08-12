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

    expect(result).toEqual({ success: true, id: 'off-grid/test-shared-model' })
    expect(await manager.listInstalled()).toContain('off-grid/test-shared-model')
    expect((await manager.getStorageInfo()).orphans).toEqual([])
    expect(await manager.getTransferableModel('off-grid/test-shared-model')).toMatchObject({
      id: 'off-grid/test-shared-model',
      name: 'Test shared model',
      kind: 'vision',
      source: 'downloaded',
      files: [
        { name: primary, sizeBytes: primaryBytes.length },
        { name: projector, sizeBytes: projectorBytes.length }
      ]
    })
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
