import { afterAll, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import shipped from '../../../catalog/models.json'

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

const BONSAI = 'prism-ml/Ternary-Bonsai-2-27B-gguf'

describe('setup recommends from the recommended catalog', () => {
  it('each mode takes the same Fast, Balanced or Best the Models screen shows, never an app-only model', async () => {
    const setup = await import('../setup')
    const manager = await import('../models-manager')
    const { pickModelsForDevice, toPickCandidate } = await import('@offgrid/models')
    const { totalBytes } = await import('../model-sizing')
    const totalmem = vi.spyOn(os, 'totalmem')
    try {
      for (const gb of [8, 16, 24, 32, 64]) {
        totalmem.mockReturnValue(gb * 1e9)
        const pool = (await manager.desktopCatalog()).filter(
          (m) =>
            (m.kind === 'text' || m.kind === 'vision') &&
            !m.quantOf &&
            m.availability !== 'coming_soon' &&
            !manager.isAppOnlyModel(m.id)
        )
        const picks = pickModelsForDevice(
          pool.map((m) => toPickCandidate(m, totalBytes(m as never))),
          gb
        )
        const chosen = {
          conservative: (await setup.recommendChatModel('conservative'))?.id,
          balanced: (await setup.recommendChatModel('balanced'))?.id,
          extreme: (await setup.recommendChatModel('extreme'))?.id
        }
        expect(chosen.conservative).toBe(picks.fast ?? picks.balanced ?? picks.best)
        expect(chosen.balanced).toBe(picks.balanced ?? picks.fast ?? picks.best)
        expect(chosen.extreme).toBe(picks.best ?? picks.balanced ?? picks.fast)
        // Bonsai is listed by this app's code, not the catalog JSON: it stays downloadable but is
        // never what setup gets for you.
        expect(Object.values(chosen)).not.toContain(BONSAI)
        expect((await setup.getSetupPlan('balanced')).items[0]?.id).toBe(chosen.balanced)
      }
    } finally {
      totalmem.mockRestore()
    }
  })

  it('Bonsai is still listed, and a model the catalog JSON lists can be a pick', async () => {
    const manager = await import('../models-manager')
    expect((await manager.desktopCatalog()).some((m) => m.id === BONSAI)).toBe(true)
    expect(manager.isAppOnlyModel(BONSAI)).toBe(true)
    // The JSON this build ships is the offline default: its models are in the catalog at once.
    const ids = new Set((await manager.desktopCatalog()).map((m) => m.id))
    for (const entry of shipped.sections.models) expect(ids.has(entry.id)).toBe(true)
  })
})
