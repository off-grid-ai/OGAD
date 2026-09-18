import { afterAll, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-bonsai-setup-'))

vi.mock('electron', () => ({
  app: {
    getPath: () => testDir,
    isPackaged: false,
    getAppPath: () => process.cwd(),
    getVersion: () => 'test'
  },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString()
  }
}))

afterAll(() => fs.rmSync(testDir, { recursive: true, force: true }))

describe('Balanced setup preview', () => {
  it('offers Bonsai at 16 GB and keeps the smaller-machine and Conservative choices', async () => {
    const setup = await import('../setup')
    const totalmem = vi.spyOn(os, 'totalmem')
    try {
      totalmem.mockReturnValue(8e9)
      expect((await setup.getSetupPlan('balanced')).items[0]?.id).not.toBe(
        'prism-ml/Ternary-Bonsai-2-27B-gguf'
      )

      totalmem.mockReturnValue(16e9)
      const capable = await setup.getSetupPlan('balanced')
      expect(capable.items[0]?.id).toBe('prism-ml/Ternary-Bonsai-2-27B-gguf')
      expect(capable.items[0]!.sizeGb).toBeGreaterThan(7.8)
      expect((await setup.getSetupPlan('conservative')).items[0]?.id).not.toBe(
        'prism-ml/Ternary-Bonsai-2-27B-gguf'
      )
    } finally {
      totalmem.mockRestore()
    }
  })
})
