/**
 * Persistence integration for settings consumers. Electron's user-data path is the
 * only fake boundary; prompt and residency behavior uses the production SQLite store.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-settings-consumers-'))

vi.mock('electron', () => ({
  app: { getPath: () => TMP_DIR, isPackaged: false, getAppPath: () => process.cwd() },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString()
  }
}))

import * as db from '../database'
import { PROMPT_REGISTRY } from '../prompts'
import { getPrompt, getPromptTemplate, resetPrompt } from '../prompt-store'
import { getResidency, getResidencyMode, setResidencyMode } from '../runtime-residency'
import { DEFAULT_RUNTIME_RESIDENCY as DEFAULT_RESIDENCY } from '@offgrid/models'

const RESIDENCY_KEY = 'runtime:residency'

beforeEach(() => {
  db.deleteSetting(RESIDENCY_KEY)
  for (const prompt of PROMPT_REGISTRY) {
    resetPrompt(prompt.key)
  }
})

afterAll(() => {
  fs.rmSync(TMP_DIR, { recursive: true, force: true })
})

describe('prompt persistence', () => {
  it('resolves every registered prompt to its default when no override exists', () => {
    for (const prompt of PROMPT_REGISTRY) {
      expect(getPromptTemplate(prompt.key)).toBe(prompt.defaultTemplate)
    }
  })

  it('reads, fills, and resets a persisted custom template', () => {
    db.saveSetting('prompt:ragChat', 'Question: {{QUERY}}')

    expect(getPrompt('ragChat', { QUERY: 'where is the data?' })).toBe(
      'Question: where is the data?'
    )

    resetPrompt('ragChat')
    expect(getPromptTemplate('ragChat')).toBe(
      PROMPT_REGISTRY.find((prompt) => prompt.key === 'ragChat')?.defaultTemplate
    )
  })
})

describe('runtime residency persistence', () => {
  it('returns defaults when no residency value is persisted', () => {
    expect(getResidency()).toEqual(DEFAULT_RESIDENCY)
  })

  it('normalizes a persisted partial map and forces locked modalities resident', () => {
    db.saveSetting(RESIDENCY_KEY, { image: 'resident', llm: 'on-demand' })

    expect(getResidency()).toEqual({
      image: 'resident',
      llm: 'resident',
      stt: 'on-demand',
      tts: 'on-demand'
    })
  })

  it('falls back to defaults when the persisted JSON is corrupt', () => {
    db.getDB()
      .prepare(
        `INSERT INTO app_settings (key, value)
         VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`
      )
      .run(RESIDENCY_KEY, '{not json')

    expect(getResidency()).toEqual(DEFAULT_RESIDENCY)
  })

  it('persists unlocked modalities without clobbering the others', () => {
    setResidencyMode('stt', 'resident')
    setResidencyMode('tts', 'resident')

    expect(getResidency()).toEqual({
      llm: 'resident',
      image: 'on-demand',
      stt: 'resident',
      tts: 'resident'
    })
    expect(getResidencyMode('stt')).toBe('resident')
  })

  it('persists locked modalities as resident when on-demand is requested', () => {
    expect(setResidencyMode('llm', 'on-demand').llm).toBe('resident')
    expect(getResidencyMode('llm')).toBe('resident')
  })
})
