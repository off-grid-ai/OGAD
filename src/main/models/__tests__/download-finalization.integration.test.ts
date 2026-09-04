import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const originalDataDir = process.env.OFFGRID_DATA_DIR
const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-download-finalization-'))
const dataDir = path.join(testRoot, 'data')
process.env.OFFGRID_DATA_DIR = dataDir

vi.mock('electron', () => ({
  app: {
    getPath: () => dataDir,
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

await import('../../model-services')
const manager = {
  ...(await import('../../models-manager')),
  ...(await import('./download-facade-test-client'))
}

const MODEL_ID = 'off-grid/finalization-download'
const PRIMARY = 'finalization-download-Q4_K_M.gguf'
const PROJECTOR = 'finalization-download-mmproj-F16.gguf'
const artifact = (marker: number): Buffer =>
  Buffer.concat([Buffer.from('GGUF', 'ascii'), Buffer.alloc(2_048, marker)])
const primaryBytes = artifact(21)
const projectorBytes = artifact(22)

beforeAll(() => {
  fs.mkdirSync(path.join(dataDir, 'models'), { recursive: true })
})

afterEach(() => vi.unstubAllGlobals())

afterAll(async () => {
  await manager.shutdownModelDownloads()
  if (originalDataDir === undefined) delete process.env.OFFGRID_DATA_DIR
  else process.env.OFFGRID_DATA_DIR = originalDataDir
  fs.rmSync(testRoot, { recursive: true, force: true })
})

describe('download finalization', () => {
  it('reports failed activation repair and completes an idempotent retry', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input)
        if (url.endsWith(`/api/models/${MODEL_ID}`)) {
          return new Response(
            JSON.stringify({
              siblings: [
                { rfilename: PRIMARY, size: primaryBytes.length },
                { rfilename: PROJECTOR, size: projectorBytes.length }
              ]
            }),
            { status: 200, headers: { 'content-type': 'application/json' } }
          )
        }
        const body = url.endsWith(PRIMARY) ? primaryBytes : projectorBytes
        return new Response(new Uint8Array(body), {
          status: 200,
          headers: { 'content-length': String(body.length) }
        })
      })
    )

    const activePath = path.join(dataDir, 'models', 'active-model.json')
    fs.writeFileSync(activePath, JSON.stringify({ id: MODEL_ID, primary: PRIMARY, mmproj: null }))
    fs.chmodSync(activePath, 0o400)

    await expect(manager.downloadModel(MODEL_ID)).resolves.toEqual({
      success: false,
      error: expect.stringContaining('permission denied')
    })
    expect(await manager.downloadStatus(MODEL_ID)).toMatchObject({
      status: 'completed',
      error: expect.stringContaining('permission denied')
    })

    fs.chmodSync(activePath, 0o600)
    await expect(manager.downloadModel(MODEL_ID)).resolves.toEqual({ success: true })
    expect(JSON.parse(fs.readFileSync(activePath, 'utf8')).mmproj).toBe(PROJECTOR)
  })
})
