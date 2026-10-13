// Fresh installs start on the fastest settings; existing installs keep theirs. Real SQLite
// settings and the real LLM service over a temp data folder; only Electron is stubbed.
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-best-settings-'))

vi.mock('electron', () => ({
  app: { getPath: () => TMP_DIR, isPackaged: false, getAppPath: () => process.cwd() },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString()
  },
  BrowserWindow: { getAllWindows: () => [] }
}))

import { deleteSetting, getSetting } from '../database'
import { llm } from '../llm'
import { markSpeedSettingsManual, prepareBestSettingsOnStartup } from '../best-settings'

const STATE_KEY = 'runtime:best-settings'
const settingsFile = (): string => path.join(llm.getModelsDir(), 'llm-settings.json')

beforeEach(() => {
  deleteSetting(STATE_KEY)
  fs.rmSync(settingsFile(), { force: true })
})
afterAll(() => fs.rmSync(TMP_DIR, { recursive: true, force: true }))

describe('fastest settings on install', () => {
  it('puts a fresh install under automatic management before any model exists', async () => {
    await prepareBestSettingsOnStartup()

    expect(getSetting(STATE_KEY, null)).toEqual({ mode: 'auto' })
  })

  it('leaves an install that already saved its own settings alone', async () => {
    fs.mkdirSync(llm.getModelsDir(), { recursive: true })
    fs.writeFileSync(settingsFile(), JSON.stringify({ kvCacheType: 'q4_0' }))

    await prepareBestSettingsOnStartup()

    expect(getSetting(STATE_KEY, null)).toEqual({ mode: 'manual' })
  })

  it('stops managing once the person changes a speed setting by hand', async () => {
    await prepareBestSettingsOnStartup()
    markSpeedSettingsManual()

    expect(getSetting(STATE_KEY, null)).toEqual({ mode: 'manual' })
    // A later start keeps their choice.
    await prepareBestSettingsOnStartup()
    expect(getSetting(STATE_KEY, null)).toEqual({ mode: 'manual' })
  })
})
