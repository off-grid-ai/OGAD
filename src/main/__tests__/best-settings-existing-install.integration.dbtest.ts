// An install upgraded from 0.0.54 / 0.0.55-beta.114 has a chat model and its own backend and
// Computer Use choices, but no llm-settings.json (those builds wrote it only when a chat setting
// was changed by hand). Its own choices must survive the first start on this build. Real SQLite
// settings and the real LLM service over a temp data folder; only Electron is stubbed.
import { afterAll, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-best-settings-upgrade-'))

vi.mock('electron', () => ({
  app: { getPath: () => TMP_DIR, isPackaged: false, getAppPath: () => process.cwd() },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString()
  },
  BrowserWindow: { getAllWindows: () => [] }
}))

import { llm } from '../llm'
import { prepareBestSettingsOnStartup } from '../best-settings'
import { getBackendPreferences, setBackendPreference } from '../backend-preferences'
import { getComputerUseSettings, setComputerUseSettings } from '../computer-use-settings'

afterAll(() => fs.rmSync(TMP_DIR, { recursive: true, force: true }))

describe('fastest settings on an upgraded install', () => {
  it('keeps the backend and Computer Use choices the person made before upgrading', async () => {
    // The person's existing chat model, selected as the active one.
    const modelsDir = llm.getModelsDir()
    fs.mkdirSync(modelsDir, { recursive: true })
    fs.writeFileSync(path.join(modelsDir, 'existing-chat-model.gguf'), 'GGUF')
    fs.writeFileSync(
      path.join(modelsDir, 'active-model.json'),
      JSON.stringify({ primary: 'existing-chat-model.gguf' })
    )
    // Choices made by hand in the Backends and Computer Use panels of the older build.
    setBackendPreference('llm', 'cpu')
    setComputerUseSettings({ ...getComputerUseSettings(), screenshotSize: 'large' })
    expect(fs.existsSync(path.join(modelsDir, 'llm-settings.json'))).toBe(false)

    // Applying fastest settings ends by restarting the chat engine, which cannot start on this
    // placeholder model file; the settings it writes before that restart are what is checked.
    await prepareBestSettingsOnStartup().catch(() => {})

    expect.soft(getBackendPreferences().llm).toBe('cpu')
    expect.soft(getComputerUseSettings().screenshotSize).toBe('large')
  })
})
