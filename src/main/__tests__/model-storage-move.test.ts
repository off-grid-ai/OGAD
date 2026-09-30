import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { moveModelStorage } from '../model-storage-move'
import { readModelStorageChoice } from '../model-storage-choice'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

function fixture(): { profile: string; source: string; destination: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'og-model-move-'))
  roots.push(root)
  const profile = path.join(root, 'profile')
  const source = path.join(profile, 'models')
  const destination = path.join(root, 'destination')
  fs.mkdirSync(source, { recursive: true })
  fs.mkdirSync(destination)
  return { profile, source, destination }
}

describe('move model storage', () => {
  it('copies files, switches the folder, and removes the old copies', async () => {
    const { profile, source, destination } = fixture()
    fs.writeFileSync(path.join(source, 'weight.gguf'), 'weights')
    fs.mkdirSync(path.join(source, '.cache'))
    fs.writeFileSync(path.join(source, '.cache', 'tokenizer.json'), '{}')
    const result = await moveModelStorage(profile, source, destination)
    expect(result).toEqual({ moved: 2 })
    expect(fs.readFileSync(path.join(destination, 'weight.gguf'), 'utf8')).toBe('weights')
    expect(fs.readFileSync(path.join(destination, '.cache', 'tokenizer.json'), 'utf8')).toBe('{}')
    expect(fs.readdirSync(source)).toEqual([])
    expect(readModelStorageChoice(profile)).toBe(fs.realpathSync(destination))
  })

  it('keeps the old folder and choice when a destination file conflicts', async () => {
    const { profile, source, destination } = fixture()
    fs.writeFileSync(path.join(source, 'weight.gguf'), 'old')
    fs.writeFileSync(path.join(destination, 'weight.gguf'), 'other')
    await expect(moveModelStorage(profile, source, destination)).rejects.toThrow('already contains')
    expect(fs.readFileSync(path.join(source, 'weight.gguf'), 'utf8')).toBe('old')
    expect(readModelStorageChoice(profile)).toBeNull()
  })
})
