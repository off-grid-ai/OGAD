import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-computer-use-settings-'))

vi.mock('electron', () => ({
  app: { getPath: () => TMP_DIR, isPackaged: false, getAppPath: () => process.cwd() },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString()
  }
}))

import { deleteSetting, getDB } from '../database'
import {
  getComputerUseSettings,
  patchComputerUseSettings,
  readComputerUseSettings,
  setComputerUseSettings
} from '../computer-use-settings'
import { COMPUTER_USE_SETTINGS_KEY } from '../../shared/computer-use-settings'
import { TaskHistoryStore } from '../tasks/task-history-store'
import { recentVisualFacts } from '../vision/visual-context'

beforeEach(() => {
  deleteSetting(COMPUTER_USE_SETTINGS_KEY)
  const history = new TaskHistoryStore(getDB())
  history.migrate()
  getDB().prepare('DELETE FROM task_run_history').run()
})
afterAll(() => fs.rmSync(TMP_DIR, { recursive: true, force: true }))

describe('Computer Use settings persistence', () => {
  it('persists one normalized object in SQLite', () => {
    setComputerUseSettings({
      modelStrategy: 'same_as_chat',
      context: '32k',
      screenshotSize: 'large',
      screenshotQuality: 'detailed',
      checkpointInterval: 8,
      retrieveOlderVisuals: true
    })

    expect(getComputerUseSettings()).toEqual({
      modelStrategy: 'same_as_chat',
      context: '32k',
      screenshotSize: 'large',
      screenshotQuality: 'detailed',
      checkpointInterval: 8,
      retrieveOlderVisuals: true,
      visualHistoryFrames: 2
    })
  })

  it('normalizes invalid persisted input before runtime use', () => {
    setComputerUseSettings({ checkpointInterval: 2, screenshotSize: 'unknown' })
    expect(getComputerUseSettings()).toMatchObject({
      checkpointInterval: 8,
      screenshotSize: 'balanced'
    })
  })

  it('persists the text reasoner plus grounding specialist strategy', () => {
    setComputerUseSettings({ modelStrategy: 'text_plus_specialist' })

    expect(getComputerUseSettings()).toMatchObject({
      modelStrategy: 'text_plus_specialist'
    })
  })

  it('reads through a typed owner port and patches from the latest authoritative value', () => {
    setComputerUseSettings({
      modelStrategy: 'text_plus_specialist',
      context: '16k',
      screenshotSize: 'large',
      checkpointInterval: 8
    })

    expect(readComputerUseSettings()).toEqual({
      status: 'available',
      settings: expect.objectContaining({
        modelStrategy: 'text_plus_specialist',
        context: '16k',
        screenshotSize: 'large',
        checkpointInterval: 8
      })
    })

    expect(patchComputerUseSettings({ context: '32k' })).toEqual({
      status: 'available',
      settings: expect.objectContaining({
        modelStrategy: 'text_plus_specialist',
        context: '32k',
        screenshotSize: 'large',
        checkpointInterval: 8
      })
    })
  })

  it('retrieves only bounded text outcomes from older Computer Use runs', () => {
    const history = new TaskHistoryStore(getDB(), () => 100)
    history.upsert({
      taskId: 'older',
      kind: 'computer_use',
      title: 'Open Settings',
      status: 'done',
      summary: 'Settings opened'
    })
    history.upsert({
      taskId: 'current',
      kind: 'computer_use',
      title: 'Current task',
      status: 'done',
      summary: 'Must not be returned'
    })

    expect(recentVisualFacts('current')).toEqual(['Open Settings: Settings opened'])
  })
})
