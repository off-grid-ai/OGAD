import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CATALOG } from '@offgrid/models'
import { flushDiagnosticLog } from '../diagnostics-log'
import { configureRuntime } from '../runtime-env'
import { readModelStorageChoice, saveModelStorageChoice } from '../model-storage-choice'
import { getStorageInfo, listInstalled, reconcileActiveModelProjector } from '../models-manager'

let profile: string
let folder: string
const write = (name: string, value: string): void => {
  fs.mkdirSync(path.dirname(path.join(folder, name)), { recursive: true })
  fs.writeFileSync(path.join(folder, name), value)
}

beforeEach(() => {
  profile = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-hand-copy-')))
  folder = path.join(profile, 'copied-models')
  fs.mkdirSync(folder)
  saveModelStorageChoice(profile, folder)
  configureRuntime({ dataDir: profile, modelsDir: readModelStorageChoice(profile)! })
})
afterEach(async () => {
  await flushDiagnosticLog()
  configureRuntime({ dataDir: undefined, modelsDir: undefined })
  fs.rmSync(profile, { recursive: true, force: true })
})

describe('a model folder copied and edited by hand', () => {
  it('still lists the models on disk when its registries hold rows the app cannot use', async () => {
    const entry = CATALOG.find((model) => model.id === 'unsloth/gemma-4-E4B-it-GGUF')!
    for (const file of entry.files) write(file.name, `GGUF${'x'.repeat(1024)}`)
    // Rows a person can leave behind: an empty object, null, and a row with no file list.
    write('downloaded-models.json', JSON.stringify([{}, null, { id: 'x/y', name: 'Y' }]))
    write('local-models.json', JSON.stringify([{}, null, { id: 'local-z', name: 'Z' }]))
    write('active-model.json', 'null')

    await expect(reconcileActiveModelProjector()).resolves.toBe(false)
    expect(await listInstalled()).toContain(entry.id)
    const storage = await getStorageInfo()
    expect(storage.unavailable).toBeUndefined()
    expect(storage.models.map((model) => model.id)).toContain(entry.id)
    // Model weights are never removed by the read.
    for (const file of entry.files) expect(fs.existsSync(path.join(folder, file.name))).toBe(true)
  })
})
