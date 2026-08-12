/**
 * The real LLM settings owner persists user-controlled values and emits one committed sync
 * mutation per changed key. Applying a remote winner uses the same owner with emission suppressed,
 * preventing an echo loop.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SyncMutation } from '../../sync-mutation'

describe('LLM settings sync contract', () => {
  let dataDir: string
  const previousDataDir = process.env.OFFGRID_DATA_DIR

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-settings-sync-'))
    fs.mkdirSync(path.join(dataDir, 'models'), { recursive: true })
    process.env.OFFGRID_DATA_DIR = dataDir
    vi.resetModules()
  })

  afterEach(() => {
    if (previousDataDir === undefined) delete process.env.OFFGRID_DATA_DIR
    else process.env.OFFGRID_DATA_DIR = previousDataDir
    fs.rmSync(dataDir, { recursive: true, force: true })
  })

  it('emits changed safe keys and suppresses a remote apply echo', async () => {
    const mutations: SyncMutation[] = []
    const [{ registerHook, HOOKS }, { LLMService }] = await Promise.all([
      import('../../bootstrap/hookRegistry'),
      import('../../llm')
    ])
    registerHook(HOOKS.syncRecordLocalMutation, (mutation: SyncMutation) => {
      mutations.push(mutation)
    })
    const settings = new LLMService()

    await settings.setSettings({ temperature: 0.35, topP: 0.8 })

    expect(mutations).toEqual([
      {
        entity: 'model_setting',
        entityId: 'temperature',
        kind: 'put',
        fields: { value: 0.35 }
      },
      {
        entity: 'model_setting',
        entityId: 'topP',
        kind: 'put',
        fields: { value: 0.8 }
      }
    ])
    expect(
      JSON.parse(fs.readFileSync(path.join(dataDir, 'models', 'llm-settings.json'), 'utf8'))
    ).toMatchObject({ temperature: 0.35, topP: 0.8 })

    await settings.setSettings({ temperature: 0.55 }, { emitSync: false })
    expect(settings.getSettings().temperature).toBe(0.55)
    expect(mutations).toHaveLength(2)
  })
})
