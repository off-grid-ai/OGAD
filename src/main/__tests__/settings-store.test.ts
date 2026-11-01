import { beforeEach, describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { createSettingsStore, initializeSettingsStore, type SettingsStore } from '../settings-store'

let database: DatabaseSync
let store: SettingsStore

beforeEach(() => {
  database = new DatabaseSync(':memory:')
  initializeSettingsStore(database)
  store = createSettingsStore(database)
})

describe('createSettingsStore', () => {
  it('returns the supplied default for missing and corrupt values', () => {
    expect(store.get('missing', { enabled: false })).toEqual({ enabled: false })
    store.set('broken', { saved: true })
    // A damaged file: the stored value is cut short (a disk fault, not a write path).
    database.prepare('UPDATE app_settings SET value = ? WHERE key = ?').run('{no', 'broken')
    expect(store.get('broken', 'fallback')).toBe('fallback')
  })

  it('round-trips typed values and overwrites an existing key', () => {
    store.set('feature', { enabled: true, count: 2 })
    expect(store.get('feature', {})).toEqual({ enabled: true, count: 2 })

    store.set('feature', ['updated'])
    expect(store.get('feature', [])).toEqual(['updated'])
  })

  it('deletes a value so subsequent reads return the default', () => {
    store.set('temporary', true)
    store.delete('temporary')
    expect(store.get('temporary', false)).toBe(false)
  })
})
