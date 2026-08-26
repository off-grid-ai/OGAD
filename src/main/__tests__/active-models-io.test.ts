/**
 * IO tests for the active-modalities store (getActiveModal / setActiveModal /
 * getAllActiveModals). The pure decision helpers (modalityForKind, isModelActive) are
 * covered in active-models.test.ts; this file exercises the thin JSON-file persistence
 * against a REAL temp dir (no mock of our own logic) so a corrupt/absent file, a round
 * trip, and the null-clear path all fail loudly if the behavior breaks.
 *
 * The store receives a per-test temp directory. The JSON serialization and
 * filesystem reads/writes are the production implementation.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

import {
  ActiveModalityStore,
  getActiveModal,
  getAllActiveModals,
  setActiveModal
} from '../active-models'

let tmpDir: string
let store: ActiveModalityStore
const originalDataDir = process.env.OFFGRID_DATA_DIR

const storePath = (): string => path.join(tmpDir, 'active-modalities.json')

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-active-models-'))
  store = new ActiveModalityStore(() => tmpDir)
  process.env.OFFGRID_DATA_DIR = tmpDir
})
afterEach(() => {
  if (originalDataDir === undefined) {
    delete process.env.OFFGRID_DATA_DIR
  } else {
    process.env.OFFGRID_DATA_DIR = originalDataDir
  }
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe('getActiveModal', () => {
  it('returns null for every modality when the store file is absent', () => {
    expect(store.get('image')).toBeNull()
    expect(store.get('computer_use')).toBeNull()
    expect(store.get('speech')).toBeNull()
    expect(store.get('transcription')).toBeNull()
  })

  it('returns null when the store file is corrupt JSON (readAll swallows the parse error)', () => {
    fs.writeFileSync(storePath(), '{ this is not json')
    expect(store.get('transcription')).toBeNull()
  })

  it('reads back a persisted value', () => {
    fs.writeFileSync(storePath(), JSON.stringify({ transcription: 'csukuangfj/parakeet-v2' }))
    expect(store.get('transcription')).toBe('csukuangfj/parakeet-v2')
  })
})

describe('setActiveModal', () => {
  it('writes a value that getActiveModal reads back (round trip)', () => {
    store.set('image', 'org/jugg')
    expect(store.get('image')).toBe('org/jugg')
    // Persisted as pretty JSON in the store file.
    expect(JSON.parse(fs.readFileSync(storePath(), 'utf-8')).image).toBe('org/jugg')
  })

  it('creates the models dir if it does not exist yet', () => {
    const nested = path.join(tmpDir, 'nested', 'dir')
    tmpDir = nested
    store.set('speech', 'kokoro')
    expect(store.get('speech')).toBe('kokoro')
  })

  it('updates one modality without clobbering the others', () => {
    store.set('image', 'img-1')
    store.set('speech', 'voice-1')
    store.set('image', 'img-2')
    expect(store.get('image')).toBe('img-2')
    expect(store.get('speech')).toBe('voice-1')
  })

  it('clears a slot when set to null', () => {
    store.set('transcription', 'whisper-small')
    store.set('transcription', null)
    expect(store.get('transcription')).toBeNull()
  })

  it('leaves the slot empty when the configured directory cannot be created', () => {
    const fileInPlaceOfDirectory = path.join(tmpDir, 'not-a-directory')
    fs.writeFileSync(fileInPlaceOfDirectory, 'occupied')
    const failingStore = new ActiveModalityStore(() => fileInPlaceOfDirectory)

    expect(() => failingStore.set('image', 'img-x')).not.toThrow()
    expect(failingStore.get('image')).toBeNull()
  })
})

describe('getAllActiveModals', () => {
  it('fills every modality with null when the store is empty', () => {
    expect(store.all()).toEqual({
      computer_use: null,
      image: null,
      speech: null,
      transcription: null
    })
  })

  it('returns all three modalities, defaulting the unset ones to null', () => {
    store.set('image', 'img-x')
    expect(store.all()).toEqual({
      computer_use: null,
      image: 'img-x',
      speech: null,
      transcription: null
    })
  })

  it('reflects a full round trip across all three modalities', () => {
    store.set('image', 'a')
    store.set('computer_use', 'grounder')
    store.set('speech', 'b')
    store.set('transcription', 'c')
    expect(store.all()).toEqual({
      computer_use: 'grounder',
      image: 'a',
      speech: 'b',
      transcription: 'c'
    })
  })
})

describe('production active-model functions', () => {
  it('persist and read all modalities in the configured runtime profile', () => {
    setActiveModal('image', 'image-model')
    setActiveModal('computer_use', 'computer-use-model')
    setActiveModal('speech', 'speech-model')

    expect(getActiveModal('image')).toBe('image-model')
    expect(getAllActiveModals()).toEqual({
      computer_use: 'computer-use-model',
      image: 'image-model',
      speech: 'speech-model',
      transcription: null
    })
    expect(
      JSON.parse(fs.readFileSync(path.join(tmpDir, 'models', 'active-modalities.json'), 'utf-8'))
    ).toEqual({
      computer_use: 'computer-use-model',
      image: 'image-model',
      speech: 'speech-model'
    })
  })
})
