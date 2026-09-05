/**
 * LoRA installation through the production Desktop consumer and Shared Node download bridge. A
 * loopback HTTP server is the only external network fake; destination ownership, streaming,
 * artifact verification, promotion, progress, and installed-file reuse stay real.
 */
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-lora-download-'))
const originalDataDir = process.env.OFFGRID_DATA_DIR
process.env.OFFGRID_DATA_DIR = profile

vi.mock('electron', () => ({
  app: {
    getPath: () => profile,
    getAppPath: () => process.cwd(),
    isPackaged: false
  },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString()
  },
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: {
    on: () => undefined,
    removeListener: () => undefined,
    handle: () => undefined,
    removeHandler: () => undefined
  }
}))

const payload = Buffer.from('OFFGRID_LORA_ADAPTER_BYTES')
let server: http.Server
let url: string
let requests = 0

beforeAll(async () => {
  server = http.createServer((_request, response) => {
    requests += 1
    response.writeHead(200, {
      'content-type': 'application/octet-stream',
      'content-length': payload.length
    })
    response.end(payload)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/adapter.safetensors`
})

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve()))
  )
  if (originalDataDir === undefined) delete process.env.OFFGRID_DATA_DIR
  else process.env.OFFGRID_DATA_DIR = originalDataDir
  fs.rmSync(profile, { recursive: true, force: true })
})

describe('Desktop LoRA download through the Shared Node bridge', () => {
  it('streams, verifies, promotes, reports progress, and reuses the installed artifact', async () => {
    const { downloadLora } = await import('../imagegen')
    const progress: number[] = []

    const installed = await downloadLora(url, 'release-style.safetensors', (value) =>
      progress.push(value)
    )
    expect(fs.readFileSync(installed)).toEqual(payload)
    expect(installed).toBe(
      path.join(fs.realpathSync(profile), 'models', 'loras', 'release-style.safetensors')
    )
    expect(progress.at(-1)).toBe(100)
    expect(fs.existsSync(`${installed}.part`)).toBe(false)

    await expect(downloadLora(url, 'release-style.safetensors')).resolves.toBe(installed)
    expect(requests).toBe(1)
    await expect(downloadLora(url, '../outside.safetensors')).rejects.toThrow(
      'Invalid LoRA filename.'
    )
    expect(requests).toBe(1)
  })
})
