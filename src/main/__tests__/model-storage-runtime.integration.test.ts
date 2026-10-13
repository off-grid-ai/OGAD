import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { configureRuntime, modelStorageError, modelsDir, requireModelStorage } from '../runtime-env'
import {
  addModelScanFolder,
  readModelScanFolders,
  readModelStorageChoice,
  removeModelScanFolder,
  saveModelStorageChoice
} from '../model-storage-choice'

const roots: string[] = []
afterEach(() => {
  configureRuntime({ modelsDir: undefined })
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

function fixture(): { profile: string; folder: string } {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'og-storage-runtime-'))
  roots.push(profile)
  const folder = path.join(profile, 'external')
  fs.mkdirSync(folder)
  return { profile, folder }
}

describe('selected model storage', () => {
  it('resolves the saved folder and rejects it after a drive is removed', () => {
    const { profile, folder } = fixture()
    saveModelStorageChoice(profile, folder)
    configureRuntime({ modelsDir: readModelStorageChoice(profile)! })
    expect(modelsDir()).toBe(fs.realpathSync(folder))
    expect(modelStorageError()).toBeNull()
    fs.rmdirSync(folder)
    expect(() => requireModelStorage()).toThrow('selected model folder is unavailable')
    expect(fs.existsSync(folder)).toBe(false)
    expect(readModelStorageChoice(profile)).toBe(modelsDir())
  })

  it('keeps folder choices within their profile', () => {
    const first = fixture()
    const second = fixture()
    saveModelStorageChoice(first.profile, first.folder)
    expect(readModelStorageChoice(second.profile)).toBeNull()
    saveModelStorageChoice(second.profile, second.folder)
    expect(readModelStorageChoice(first.profile)).toBe(fs.realpathSync(first.folder))
    expect(readModelStorageChoice(second.profile)).toBe(fs.realpathSync(second.folder))
  })

  it('adds each scan folder once and removes the reference without deleting files', () => {
    const { profile, folder } = fixture()
    fs.writeFileSync(path.join(folder, 'weight.gguf'), 'weights')
    addModelScanFolder(profile, folder)
    addModelScanFolder(profile, folder)
    expect(readModelScanFolders(profile)).toEqual([fs.realpathSync(folder)])
    expect(removeModelScanFolder(profile, fs.realpathSync(folder))).toEqual([])
    expect(readModelScanFolders(profile)).toEqual([])
    expect(fs.readFileSync(path.join(folder, 'weight.gguf'), 'utf8')).toBe('weights')
  })
})
