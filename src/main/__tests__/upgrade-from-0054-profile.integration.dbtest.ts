// Upgrading from 0.0.54 / 0.0.55-beta.114: the first start on this build must keep everything
// the person set by hand and every saved chat exactly as it was. The profile is shaped like one
// those builds leave behind: an active chat model, no llm-settings.json (they wrote it only on a
// manual chat-settings change), hand-set backend, residency, Computer Use and Web Use choices,
// and a saved chat. Then the startup steps this release added run: fastest settings and the
// moved-model cleanup, after the database opens with its new migrations.
// Real SQLite settings and data, the real LLM service over a temp profile; only Electron is stubbed.
import { afterAll, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-upgrade-0054-'))

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
import { cleanupMovedModelStorage } from '../model-storage-move'
import { getBackendPreferences, setBackendPreference } from '../backend-preferences'
import { getResidency, setResidencyMode } from '../runtime-residency'
import { getComputerUseSettings, setComputerUseSettings } from '../computer-use-settings'
import { getWebUseSettings, setWebUseSettings } from '../web-use-settings'
import { addRagMessage, createRagConversation, getRagMessages } from '../database'

afterAll(() => fs.rmSync(TMP_DIR, { recursive: true, force: true }))

describe('first start after upgrading from 0.0.54', () => {
  it('keeps hand-set settings, the active model and saved chats', async () => {
    const modelsDir = llm.getModelsDir()
    fs.mkdirSync(modelsDir, { recursive: true })
    fs.writeFileSync(path.join(modelsDir, 'existing-chat-model.gguf'), 'GGUF')
    const activeModel = JSON.stringify({ primary: 'existing-chat-model.gguf' })
    fs.writeFileSync(path.join(modelsDir, 'active-model.json'), activeModel)

    setBackendPreference('llm', 'cpu')
    setBackendPreference('embeddings', 'cpu')
    setResidencyMode('stt', 'on-demand')
    setResidencyMode('embeddings', 'on-demand')
    setComputerUseSettings({
      ...getComputerUseSettings(),
      screenshotSize: 'large',
      modelStrategy: 'same_as_chat'
    })
    setWebUseSettings({ ...getWebUseSettings(), browserTarget: 'default_browser' })
    createRagConversation('chat-0054', 'Loan follow-up')
    addRagMessage('chat-0054', 'user', 'What documents are still pending?')
    addRagMessage('chat-0054', 'assistant', 'The address proof and the last salary slip.', {
      sources: []
    })

    const before = {
      backends: getBackendPreferences(),
      residency: getResidency(),
      computerUse: getComputerUseSettings(),
      webUse: getWebUseSettings(),
      messages: getRagMessages('chat-0054').map(({ role, content }) => ({ role, content }))
    }

    // The engine cannot start on this placeholder model; the start-up steps before it are checked.
    await prepareBestSettingsOnStartup().catch(() => {})
    await cleanupMovedModelStorage(TMP_DIR, modelsDir)

    expect.soft(getBackendPreferences()).toEqual(before.backends)
    expect.soft(getResidency()).toEqual(before.residency)
    expect.soft(getComputerUseSettings()).toEqual(before.computerUse)
    expect.soft(getWebUseSettings()).toEqual(before.webUse)
    expect
      .soft(getRagMessages('chat-0054').map(({ role, content }) => ({ role, content })))
      .toEqual(before.messages)
    expect.soft(fs.readFileSync(path.join(modelsDir, 'active-model.json'), 'utf8')).toBe(activeModel)
    expect.soft(fs.existsSync(path.join(modelsDir, 'existing-chat-model.gguf'))).toBe(true)
  })
})
