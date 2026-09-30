import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { readModelStorageChoice, saveModelStorageChoice } from '../model-storage-choice'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

describe('model storage choice', () => {
  it('saves a selected folder and reads it at the next startup', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'og-model-dir-'))
    roots.push(root)
    const profile = path.join(root, 'profile')
    const models = path.join(root, 'models')
    fs.mkdirSync(profile)
    fs.mkdirSync(models)
    saveModelStorageChoice(profile, models)
    expect(readModelStorageChoice(profile)).toBe(fs.realpathSync(models))
    expect(fs.readdirSync(models)).toEqual([])
  })

  it('rejects a file and keeps the prior choice', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'og-model-dir-'))
    roots.push(root)
    const profile = path.join(root, 'profile')
    const models = path.join(root, 'models')
    fs.mkdirSync(profile)
    fs.mkdirSync(models)
    saveModelStorageChoice(profile, models)
    expect(() =>
      saveModelStorageChoice(profile, path.join(profile, 'model-storage.json'))
    ).toThrow()
    expect(readModelStorageChoice(profile)).toBe(fs.realpathSync(models))
  })
})
