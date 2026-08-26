import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import {
  recordDownloaded,
  removeDownloaded,
  findDownloaded,
  readDownloaded,
  installedDownloadedIds,
  downloadedProtectedNames,
  reconcileDownloadedModelRegistry
} from '../downloaded-models'

// Real temp models dir with real files — no mocks. This is the exact registry logic
// models-manager uses for listInstalled / getStorageInfo(known) / deleteModel, so
// passing here means a downloaded HF model is registered, counts as installed, and
// is protected from the "unused files" orphan sweep (the reported MiniCPM bug).

let dir: string
// A MiniCPM-V-shaped model: a primary weight + an mmproj projector (the case that
// was landing in "unused files").
const MINICPM = {
  id: 'openbmb/MiniCPM-V-2_6-gguf',
  name: 'MiniCPM-V 2.6',
  kind: 'vision',
  files: ['minicpm-v-2_6.Q4_K_M.gguf', 'mmproj-minicpm-v-2_6-f16.gguf']
}

function writeFiles(names: string[], bytes = 2048): void {
  for (const n of names) fs.writeFileSync(path.join(dir, n), Buffer.alloc(bytes, 1))
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'og-dl-models-'))
})
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('downloaded-models registry (real temp dir)', () => {
  it('a recorded model with all files present is reported installed', () => {
    writeFiles(MINICPM.files)
    recordDownloaded(dir, MINICPM)
    expect(installedDownloadedIds(dir)).toEqual([MINICPM.id])
    expect(findDownloaded(dir, MINICPM.id)?.name).toBe('MiniCPM-V 2.6')
  })

  it('its files are PROTECTED from the orphan sweep (the fix for "unused files")', () => {
    writeFiles(MINICPM.files)
    recordDownloaded(dir, MINICPM)
    const protectedNames = downloadedProtectedNames(dir)
    // Every file the model comprises must be known/protected — this is exactly the
    // set models-manager adds to `known` so getStorageInfo won't flag them orphan.
    for (const f of MINICPM.files) expect(protectedNames.has(f)).toBe(true)
  })

  it('reproduces the bug WITHOUT registration: unregistered files are unprotected + not installed', () => {
    // Simulate the old downloadModel: files on disk, but nothing recorded.
    writeFiles(MINICPM.files)
    expect(installedDownloadedIds(dir)).toEqual([]) // never "installed"
    const protectedNames = downloadedProtectedNames(dir)
    for (const f of MINICPM.files) expect(protectedNames.has(f)).toBe(false) // -> orphaned
  })

  it('a partially-deleted model (missing a file) is NOT installed', () => {
    writeFiles([MINICPM.files[0]!]) // only the primary; mmproj missing
    recordDownloaded(dir, MINICPM)
    expect(installedDownloadedIds(dir)).toEqual([])
  })

  it('recording is idempotent (re-download replaces, never duplicates)', () => {
    writeFiles(MINICPM.files)
    recordDownloaded(dir, MINICPM)
    recordDownloaded(dir, { ...MINICPM, name: 'MiniCPM-V 2.6 (updated)' })
    const all = readDownloaded(dir)
    expect(all).toHaveLength(1)
    expect(all[0]!.name).toBe('MiniCPM-V 2.6 (updated)')
  })

  it('remove drops it from installed + protected (delete path)', () => {
    writeFiles(MINICPM.files)
    recordDownloaded(dir, MINICPM)
    removeDownloaded(dir, MINICPM.id)
    expect(installedDownloadedIds(dir)).toEqual([])
    expect(downloadedProtectedNames(dir).size).toBe(0)
    expect(findDownloaded(dir, MINICPM.id)).toBeUndefined()
  })

  it('survives a corrupt/absent registry file without throwing', () => {
    expect(readDownloaded(dir)).toEqual([]) // absent
    fs.writeFileSync(path.join(dir, 'downloaded-models.json'), 'not json{')
    expect(readDownloaded(dir)).toEqual([]) // corrupt -> empty, no throw
    expect(installedDownloadedIds(dir)).toEqual([])
  })

  it('repairs a transferred model when its catalog family gains a specialist role', () => {
    const transferred = {
      ...MINICPM,
      id: `model-package-v1:${'a'.repeat(64)}`,
      familyId: MINICPM.id,
      packageIdentity: `model-package-v1:${'a'.repeat(64)}`
    }
    writeFiles(transferred.files)
    recordDownloaded(dir, transferred)

    expect(
      reconcileDownloadedModelRegistry(dir, [
        { id: MINICPM.id, kind: 'computer_use', files: transferred.files.map((name) => ({ name })) }
      ])[0]
    ).toMatchObject({ id: transferred.id, familyId: MINICPM.id, kind: 'computer_use' })
  })
})
