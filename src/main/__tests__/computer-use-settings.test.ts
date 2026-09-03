import { beforeEach, describe, expect, it, vi } from 'vitest'

const db = vi.hoisted(() => ({ store: new Map<string, unknown>(), failReads: false, failWrites: false }))
vi.mock('../database', () => ({
  getSetting: <T>(key: string, fallback: T): T => {
    if (db.failReads) throw new Error('database locked')
    return (db.store.has(key) ? db.store.get(key) : fallback) as T
  },
  saveSetting: (key: string, value: unknown) => {
    if (db.failWrites) throw new Error('disk full')
    db.store.set(key, value)
  }
}))
const emitted = vi.hoisted(() => [] as unknown[])
vi.mock('../sync-mutation', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../sync-mutation')>()
  return { ...actual, emitSyncMutation: (mutation: unknown) => void emitted.push(mutation) }
})

import { DEFAULT_COMPUTER_USE_SETTINGS, COMPUTER_USE_SETTINGS_KEY } from '../../shared/computer-use-settings'
import { getComputerUseSettings, patchComputerUseSettings, readComputerUseSettings, setComputerUseSettings } from '../computer-use-settings'

beforeEach(() => {
  db.store.clear()
  db.failReads = false
  db.failWrites = false
  emitted.length = 0
})

describe('computer use settings port', () => {
  it('reads the normalized defaults when nothing is stored', () => {
    expect(getComputerUseSettings()).toEqual(DEFAULT_COMPUTER_USE_SETTINGS)
    expect(readComputerUseSettings()).toEqual({ status: 'available', settings: DEFAULT_COMPUTER_USE_SETTINGS })
  })

  it('patches from the latest persisted value and records one sync mutation per write', () => {
    const first = patchComputerUseSettings({} as never)
    expect(first.status).toBe('available')
    expect(db.store.get(COMPUTER_USE_SETTINGS_KEY)).toEqual(DEFAULT_COMPUTER_USE_SETTINGS)
    expect(emitted).toHaveLength(1)
    expect(emitted[0]).toMatchObject({ entity: 'model_setting', entityId: COMPUTER_USE_SETTINGS_KEY, kind: 'put' })
    setComputerUseSettings(DEFAULT_COMPUTER_USE_SETTINGS, { emitSync: false })
    expect(emitted).toHaveLength(1)
  })

  it('reports an unavailable port with the reason instead of throwing', () => {
    db.failReads = true
    expect(readComputerUseSettings()).toEqual({
      status: 'unavailable',
      error: { code: 'computer_use_settings_read_failed', message: 'Computer Use settings are unavailable. database locked' }
    })
    db.failReads = false
    db.failWrites = true
    expect(patchComputerUseSettings({} as never)).toEqual({
      status: 'unavailable',
      error: { code: 'computer_use_settings_write_failed', message: 'Computer Use settings are unavailable. disk full' }
    })
  })
})
