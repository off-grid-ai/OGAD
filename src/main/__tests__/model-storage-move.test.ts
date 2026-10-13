import { afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { setImmediate as yieldToEventLoop } from 'node:timers/promises'
import * as downloadVerify from '../models/download-verify'
import { createWindowAndScheduleModelStorageCleanup } from '../bootstrap/model-storage-cleanup'
import {
  moveModelStorage,
  leaveModelStorage,
  ownedStorageFiles,
  rewriteRegistryEntryReferences,
  cleanupMovedModelStorage,
  MOVE_SAFETY_BYTES,
  type MoveDependencies
} from '../model-storage-move'
import {
  readModelStorageChoice,
  readPendingModelCleanup,
  saveModelStorageChoice
} from '../model-storage-choice'
import { configureRuntime, modelsDir } from '../runtime-env'
import { modelReadDirectories, resolveModelAsset } from '../model-paths'
import { installedDownloadedIds, readDownloaded } from '../downloaded-models'
import * as modelPaths from '../model-paths'
import { withStorageDownload } from '../model-storage-guard'

const roots: string[] = []
afterEach(() => {
  configureRuntime({ modelsDir: undefined, dataDir: undefined })
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
  vi.restoreAllMocks()
})
function fixture(): {
  profile: string
  source: string
  destination: string
  deps: MoveDependencies
} {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'og-model-move-')))
  roots.push(root)
  const profile = path.join(root, 'profile')
  const source = path.join(profile, 'models')
  const destination = path.join(root, 'destination')
  fs.mkdirSync(source, { recursive: true })
  fs.mkdirSync(destination)
  configureRuntime({ dataDir: profile, modelsDir: source })
  fs.writeFileSync(path.join(source, 'weight.gguf'), 'weights')
  return { profile, source, destination, deps: { ownedFiles: [{ name: 'weight.gguf' }] } }
}
const move = (f: ReturnType<typeof fixture>): ReturnType<typeof moveModelStorage> =>
  moveModelStorage(f.profile, f.source, f.destination, f.deps)

describe('verified model storage move', () => {
  it('switches saved and running paths immediately and keeps old copies', async () => {
    const f = fixture()
    fs.writeFileSync(path.join(f.source, 'llm-settings.json'), '{}')
    expect(await move(f)).toEqual({ moved: 2, unknownEntriesLeft: 0 })
    expect(readModelStorageChoice(f.profile)).toBe(f.destination)
    expect(modelsDir()).toBe(f.destination)
    expect(modelReadDirectories()).toEqual([f.destination])
    expect(resolveModelAsset('weight.gguf')).toBe(path.join(f.destination, 'weight.gguf'))
    expect(fs.readFileSync(path.join(f.source, 'weight.gguf'), 'utf8')).toBe('weights')
    expect(readPendingModelCleanup(f.profile)).toHaveLength(2)
    for (const record of readPendingModelCleanup(f.profile))
      expect(record.sourceMtimeMs).toBe(fs.lstatSync(path.join(f.source, record.name)).mtimeMs)
    fs.writeFileSync(path.join(modelsDir(), 'llm-settings.json'), '{"updated":true}')
    expect(fs.readFileSync(path.join(f.source, 'llm-settings.json'), 'utf8')).toBe('{}')
  })
  it('leaves unknown shared files, links, and nested files untouched', async () => {
    const f = fixture()
    fs.writeFileSync(path.join(f.source, 'personal.txt'), 'personal')
    fs.mkdirSync(path.join(f.source, 'package'))
    fs.writeFileSync(path.join(f.source, 'package', 'projector.gguf'), 'projector')
    fs.writeFileSync(path.join(f.source, 'package', 'photo.jpg'), 'photo')
    fs.symlinkSync(path.join(f.source, 'personal.txt'), path.join(f.source, 'linked.gguf'))
    f.deps.ownedFiles.push(
      { name: 'package/projector.gguf' },
      { name: 'linked.gguf' },
      { name: '../personal.txt' }
    )
    expect(await move(f)).toEqual({ moved: 2, unknownEntriesLeft: 3 })
    expect(fs.readFileSync(path.join(f.source, 'personal.txt'), 'utf8')).toBe('personal')
    expect(fs.readFileSync(path.join(f.source, 'package/photo.jpg'), 'utf8')).toBe('photo')
    expect(fs.existsSync(path.join(f.destination, 'personal.txt'))).toBe(false)
    expect(fs.existsSync(path.join(f.destination, 'package/photo.jpg'))).toBe(false)
    expect(fs.existsSync(path.join(f.destination, 'linked.gguf'))).toBe(false)
  })
  it.each(['symbolic', 'hard', 'relative'])(
    'keeps the active model available after moving a %s link and cleaning up',
    async (link) => {
      const f = fixture()
      const shared = path.join(f.profile, 'shared.gguf')
      fs.renameSync(path.join(f.source, 'weight.gguf'), shared)
      const source = path.join(f.source, 'weight.gguf')
      if (link === 'hard') fs.linkSync(shared, source)
      else fs.symlinkSync(link === 'relative' ? '../shared.gguf' : shared, source)
      fs.writeFileSync(path.join(f.source, 'active-model.json'), '{"primary":"weight.gguf"}')
      await move(f)
      const target = path.join(f.destination, 'weight.gguf')
      expect(fs.readFileSync(target, 'utf8')).toBe('weights')
      expect(fs.lstatSync(target).isSymbolicLink()).toBe(link !== 'hard')
      if (link !== 'hard') expect(fs.realpathSync(target)).toBe(shared)
      else
        expect(readPendingModelCleanup(f.profile).map((entry) => entry.name)).not.toContain(
          'weight.gguf'
        )
      await cleanupMovedModelStorage(f.profile, f.destination)
      expect(fs.readFileSync(target, 'utf8')).toBe('weights')
      expect(fs.readFileSync(shared, 'utf8')).toBe('weights')
      expect(fs.existsSync(source)).toBe(link === 'hard')
      expect(fs.readFileSync(path.join(f.source, 'active-model.json'), 'utf8')).toBe(
        '{"primary":"weight.gguf"}'
      )
      expect(readPendingModelCleanup(f.profile)).toEqual([])
    }
  )
  it('keeps an old weight that remains the target of a moved model link', async () => {
    const f = fixture()
    fs.symlinkSync('weight.gguf', path.join(f.source, 'active.gguf'))
    fs.writeFileSync(path.join(f.source, 'active-model.json'), '{"primary":"active.gguf"}')
    await move(f)
    await cleanupMovedModelStorage(f.profile, f.destination)
    expect(fs.realpathSync(path.join(f.destination, 'active.gguf'))).toBe(
      path.join(f.source, 'weight.gguf')
    )
    expect(fs.readFileSync(path.join(f.destination, 'active.gguf'), 'utf8')).toBe('weights')
    expect(fs.readFileSync(path.join(f.source, 'weight.gguf'), 'utf8')).toBe('weights')
    expect(fs.existsSync(path.join(f.source, 'active.gguf'))).toBe(false)
  })
  it('uses registries, companions and indexed caches without claiming unknown cache files', async () => {
    const f = fixture()
    const names = [
      'custom.gguf',
      'mmproj.gguf',
      'loras/custom.safetensors',
      '.cache/executorch-speech/voice.pte'
    ]
    for (const name of names) {
      fs.mkdirSync(path.dirname(path.join(f.source, name)), { recursive: true })
      fs.writeFileSync(path.join(f.source, name), name)
    }
    fs.writeFileSync(
      path.join(f.source, 'downloaded-models.json'),
      JSON.stringify([{ files: names.slice(0, 2) }])
    )
    fs.writeFileSync(path.join(f.source, 'managed-storage-files.json'), JSON.stringify([names[2]]))
    fs.writeFileSync(
      path.join(f.source, '.cache/executorch-speech/index.json'),
      JSON.stringify({ 'voice.pte': {} })
    )
    fs.writeFileSync(path.join(f.source, '.cache/unrelated'), 'other app')
    await move(f)
    for (const name of names) expect(fs.existsSync(path.join(f.destination, name))).toBe(true)
    expect(fs.existsSync(path.join(f.destination, '.cache/unrelated'))).toBe(false)
  })
  it('refuses insufficient free space before copying anything', async () => {
    const f = fixture()
    f.deps.freeBytes = async () => MOVE_SAFETY_BYTES
    await expect(move(f)).rejects.toThrow('Not enough free space')
    expect(fs.readdirSync(f.destination)).toEqual([])
    expect(readModelStorageChoice(f.profile)).toBeNull()
    expect(modelsDir()).toBe(f.source)
    await expect(withStorageDownload(async () => 'unlocked')).resolves.toBe('unlocked')
  })
  it.each([1, 2])('refuses an active download at idle check %i', async (check) => {
    const f = fixture()
    let calls = 0
    f.deps.downloadsActive = () => ++calls === check
    await expect(move(f)).rejects.toThrow('Wait for model downloads')
    expect(fs.readdirSync(f.destination)).toEqual([])
    expect(readModelStorageChoice(f.profile)).toBeNull()
  })
  it('blocks new downloads while planning and copying, then permits them after success', async () => {
    const f = fixture()
    f.deps.freeBytes = async () => {
      await expect(withStorageDownload(async () => undefined)).rejects.toThrow('being moved')
      return Number.MAX_SAFE_INTEGER
    }
    await move(f)
    await withStorageDownload(async () => {
      expect(modelsDir()).toBe(f.destination)
      fs.writeFileSync(path.join(modelsDir(), 'new.part'), 'download')
    })
    expect(fs.existsSync(path.join(f.source, 'new.part'))).toBe(false)
  })
  it('refuses a download that started before model resolution completed', async () => {
    const f = fixture()
    await withStorageDownload(async () => {
      await expect(move(f)).rejects.toThrow('Wait for model downloads')
    })
    expect(fs.readdirSync(f.destination)).toEqual([])
  })
  it('verifies known hashes and rolls back a failed copy', async () => {
    const f = fixture()
    f.deps.ownedFiles[0]!.sha256 = createHash('sha256').update('different').digest('hex')
    await expect(move(f)).rejects.toThrow('Cannot verify')
    expect(fs.readdirSync(f.destination)).toEqual([])
    expect(fs.readFileSync(path.join(f.source, 'weight.gguf'), 'utf8')).toBe('weights')
    expect(modelsDir()).toBe(f.source)
  })
  it('takes the latest settings snapshot before switching and verifies a matching catalog hash', async () => {
    const f = fixture()
    f.deps.ownedFiles[0]!.sha256 = createHash('sha256').update('weights').digest('hex')
    fs.writeFileSync(path.join(f.source, 'llm-settings.json'), '{}')
    f.deps.freeBytes = async () => {
      fs.writeFileSync(path.join(f.source, 'llm-settings.json'), '{"latest":true}')
      return Number.MAX_SAFE_INTEGER
    }
    await move(f)
    expect(fs.readFileSync(path.join(f.destination, 'llm-settings.json'), 'utf8')).toBe(
      '{"latest":true}'
    )
    expect(
      readPendingModelCleanup(f.profile).find((entry) => entry.name === 'llm-settings.json')?.size
    ).toBe(15)
  })
  it('does not overwrite a destination file created after planning', async () => {
    const f = fixture()
    f.deps.freeBytes = async () => {
      fs.writeFileSync(path.join(f.destination, 'weight.gguf'), 'personal')
      return Number.MAX_SAFE_INTEGER
    }
    await expect(move(f)).rejects.toThrow()
    expect(fs.readFileSync(path.join(f.destination, 'weight.gguf'), 'utf8')).toBe('personal')
    expect(fs.readFileSync(path.join(f.source, 'weight.gguf'), 'utf8')).toBe('weights')
    expect(modelsDir()).toBe(f.source)
  })
  it('keeps the old files and choice on destination conflict or save failure', async () => {
    const f = fixture()
    fs.writeFileSync(path.join(f.destination, 'weight.gguf'), 'other')
    await expect(move(f)).rejects.toThrow('already contains')
    fs.unlinkSync(path.join(f.destination, 'weight.gguf'))
    fs.mkdirSync(path.join(f.profile, 'model-storage.json'))
    await expect(move(f)).rejects.toThrow()
    expect(fs.readdirSync(f.destination)).toEqual([])
    expect(fs.existsSync(path.join(f.source, 'weight.gguf'))).toBe(true)
    expect(modelsDir()).toBe(f.source)
  })
  it('rejects nested folders', async () => {
    const f = fixture()
    f.destination = path.join(f.source, 'nested')
    fs.mkdirSync(f.destination)
    await expect(move(f)).rejects.toThrow('outside')
  })
  it('keeps metadata in the old folder after cleanup for older builds', async () => {
    const f = fixture()
    const registries = [
      'active-model.json',
      'llm-settings.json',
      'downloaded-models.json',
      'local-models.json',
      'downloads.json',
      'active-modalities.json'
    ]
    for (const name of registries) fs.writeFileSync(path.join(f.source, name), '{}')
    await move(f)
    await cleanupMovedModelStorage(f.profile, f.destination)
    for (const name of registries) {
      expect(fs.readFileSync(path.join(f.source, name), 'utf8')).toBe('{}')
      expect(fs.readFileSync(path.join(f.destination, name), 'utf8')).toBe('{}')
    }
    expect(fs.existsSync(path.join(f.source, 'weight.gguf'))).toBe(false)
    expect(readPendingModelCleanup(f.profile)).toEqual([])
  })
  it('next-start cleanup removes only verified files and clears only handled records', async () => {
    const f = fixture()
    fs.writeFileSync(path.join(f.source, 'personal'), 'keep')
    await move(f)
    expect(readPendingModelCleanup(f.profile)[0]).toMatchObject({
      size: 7,
      sourceMtimeMs: fs.lstatSync(path.join(f.source, 'weight.gguf')).mtimeMs
    })
    const hash = vi.spyOn(downloadVerify, 'sha256File')
    await cleanupMovedModelStorage(f.profile, readModelStorageChoice(f.profile)!)
    expect(hash.mock.calls).toEqual([[path.join(f.destination, 'weight.gguf')]])
    expect(fs.readdirSync(f.source)).toEqual(['personal'])
    expect(fs.readFileSync(path.join(f.destination, 'weight.gguf'), 'utf8')).toBe('weights')
    expect(readPendingModelCleanup(f.profile)).toEqual([])
  })
  it('keeps a source touched after the move, even when its bytes are unchanged', async () => {
    const f = fixture()
    await move(f)
    const records = readPendingModelCleanup(f.profile)
    const source = path.join(f.source, 'weight.gguf')
    const stat = fs.lstatSync(source)
    fs.utimesSync(source, stat.atime, new Date(stat.mtimeMs + 10_000))
    const hash = vi.spyOn(downloadVerify, 'sha256File')
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    await cleanupMovedModelStorage(f.profile, f.destination)
    expect(fs.readFileSync(source, 'utf8')).toBe('weights')
    expect(readPendingModelCleanup(f.profile)).toEqual(records)
    expect(hash).not.toHaveBeenCalled()
  })
  it('hashes both copies for a legacy record without a source modification time', async () => {
    const f = fixture()
    await move(f)
    const records = readPendingModelCleanup(f.profile).map(
      ({ sourceMtimeMs: _, ...record }) => record
    )
    saveModelStorageChoice(f.profile, f.destination, records)
    const hash = vi.spyOn(downloadVerify, 'sha256File')
    await cleanupMovedModelStorage(f.profile, f.destination)
    expect(hash.mock.calls).toEqual([
      [path.join(f.source, 'weight.gguf')],
      [path.join(f.destination, 'weight.gguf')]
    ])
    expect(fs.existsSync(path.join(f.source, 'weight.gguf'))).toBe(false)
    expect(readPendingModelCleanup(f.profile)).toEqual([])
  })
  it('keeps legacy source copies whose content no longer matches', async () => {
    const f = fixture()
    await move(f)
    const records = readPendingModelCleanup(f.profile).map(
      ({ sourceMtimeMs: _, ...record }) => record
    )
    saveModelStorageChoice(f.profile, f.destination, records)
    fs.writeFileSync(path.join(f.source, 'weight.gguf'), 'changed')
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    await cleanupMovedModelStorage(f.profile, f.destination)
    expect(fs.existsSync(path.join(f.source, 'weight.gguf'))).toBe(true)
    expect(readPendingModelCleanup(f.profile)).toEqual(records)
  })
  it('yields between files and hashes only one file at a time', async () => {
    const f = fixture()
    fs.writeFileSync(path.join(f.source, 'second.gguf'), 'second')
    f.deps.ownedFiles.push({ name: 'second.gguf' })
    await move(f)
    const originalHash = downloadVerify.sha256File
    let hashing = false
    let eventLoopTurnCompleted = true
    vi.spyOn(downloadVerify, 'sha256File').mockImplementation(async (file) => {
      expect(hashing).toBe(false)
      expect(eventLoopTurnCompleted).toBe(true)
      hashing = true
      const hash = await originalHash(file)
      hashing = false
      eventLoopTurnCompleted = false
      setImmediate(() => {
        eventLoopTurnCompleted = true
      })
      return hash
    })
    await cleanupMovedModelStorage(f.profile, f.destination)
    expect(readPendingModelCleanup(f.profile)).toEqual([])
    await yieldToEventLoop()
  })
  it('retains the source and new journal when the active folder changes during hashing', async () => {
    const f = fixture()
    await move(f)
    const records = readPendingModelCleanup(f.profile)
    const originalHash = downloadVerify.sha256File
    const extra = { ...records[0]!, name: 'new.gguf' }
    vi.spyOn(downloadVerify, 'sha256File').mockImplementation(async (file) => {
      const hash = await originalHash(file)
      saveModelStorageChoice(f.profile, f.source, [...records, extra])
      return hash
    })
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    await cleanupMovedModelStorage(f.profile, f.destination)
    expect(fs.existsSync(path.join(f.source, 'weight.gguf'))).toBe(true)
    expect(readModelStorageChoice(f.profile)).toBe(f.source)
    expect(readPendingModelCleanup(f.profile)).toEqual([...records, extra])
  })
  it('keeps a source changed while the destination is being hashed', async () => {
    const f = fixture()
    await move(f)
    const records = readPendingModelCleanup(f.profile)
    const originalHash = downloadVerify.sha256File
    vi.spyOn(downloadVerify, 'sha256File').mockImplementation(async (file) => {
      const hash = await originalHash(file)
      const source = path.join(f.source, 'weight.gguf')
      const stat = fs.lstatSync(source)
      fs.utimesSync(source, stat.atime, new Date(stat.mtimeMs + 10_000))
      return hash
    })
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    await cleanupMovedModelStorage(f.profile, f.destination)
    expect(fs.existsSync(path.join(f.source, 'weight.gguf'))).toBe(true)
    expect(readPendingModelCleanup(f.profile)).toEqual(records)
  })
  it('clears a missing source record without deleting the destination', async () => {
    const f = fixture()
    await move(f)
    fs.unlinkSync(path.join(f.source, 'weight.gguf'))
    await cleanupMovedModelStorage(f.profile, f.destination)
    expect(readPendingModelCleanup(f.profile)).toEqual([])
    expect(fs.readFileSync(path.join(f.destination, 'weight.gguf'), 'utf8')).toBe('weights')
  })
  it.each(['missing', 'size', 'content', 'source', 'inactive', 'source-link', 'source-hardlink'])(
    'keeps old copies on %s verification failure',
    async (failure) => {
      const f = fixture()
      fs.writeFileSync(path.join(f.source, 'active-model.json'), '{}')
      await move(f)
      const target = path.join(f.destination, 'weight.gguf')
      if (failure === 'missing') fs.unlinkSync(target)
      if (failure === 'size') fs.writeFileSync(target, 'x')
      if (failure === 'content') fs.writeFileSync(target, 'changed')
      if (failure === 'source-link') {
        fs.unlinkSync(path.join(f.source, 'weight.gguf'))
        fs.symlinkSync(target, path.join(f.source, 'weight.gguf'))
      }
      if (failure === 'source-hardlink')
        fs.linkSync(path.join(f.source, 'weight.gguf'), path.join(f.source, 'linked.gguf'))
      if (failure === 'source') fs.writeFileSync(path.join(f.source, 'weight.gguf'), 'changed')
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
      await cleanupMovedModelStorage(f.profile, failure === 'inactive' ? f.source : f.destination)
      expect(fs.existsSync(path.join(f.source, 'weight.gguf'))).toBe(true)
      expect(readPendingModelCleanup(f.profile)).toHaveLength(failure === 'inactive' ? 2 : 1)
      expect(warn).toHaveBeenCalled()
    }
  )
  it('reads legacy choices and preserves pending cleanup when a later folder is selected', async () => {
    const f = fixture()
    fs.writeFileSync(path.join(f.profile, 'model-storage.json'), JSON.stringify(f.source))
    expect(readModelStorageChoice(f.profile)).toBe(f.source)
    await move(f)
    saveModelStorageChoice(f.profile, f.source)
    expect(readPendingModelCleanup(f.profile)).toHaveLength(1)
  })
})

describe('model cleanup startup scheduling', () => {
  it('creates the window before cleanup and completes startup without awaiting cleanup', async () => {
    const events: string[] = []
    let windowCreated!: () => void
    let finishCleanup!: () => void
    const windowReady = new Promise<void>((resolve) => {
      windowCreated = resolve
    })
    const cleanupFinished = new Promise<void>((resolve) => {
      finishCleanup = resolve
    })
    const cleanup = vi.fn(async () => {
      events.push('cleanup')
      await cleanupFinished
    })
    const startup = createWindowAndScheduleModelStorageCleanup(async () => {
      await windowReady
      events.push('window')
    }, cleanup)
    await yieldToEventLoop()
    expect(events).toEqual([])
    windowCreated()
    await startup
    events.push('startup-complete')
    expect(cleanup).not.toHaveBeenCalled()
    await yieldToEventLoop()
    expect(events).toEqual(['window', 'startup-complete', 'cleanup'])
    finishCleanup()
    await cleanupFinished
  })
  it.each(['sync', 'async'])(
    'logs a %s cleanup failure without rejecting startup',
    async (failure) => {
      const error = new Error('cleanup failed')
      const log = vi.spyOn(console, 'error').mockImplementation(() => undefined)
      await createWindowAndScheduleModelStorageCleanup(
        async () => undefined,
        () => {
          if (failure === 'sync') throw error
          return Promise.reject(error)
        }
      )
      await yieldToEventLoop()
      expect(log).toHaveBeenCalledWith('[model-storage] Background cleanup failed:', error)
    }
  )
})

describe('registry reference rewriting', () => {
  it('rewrites every supported field and preserves all other values without mutation', () => {
    const entry = {
      id: 'fixture',
      files: [
        'weight.gguf',
        { name: 'projector.gguf', sha256: 'digest', role: 'projector' },
        null,
        42,
        {},
        { name: 7 },
        ['nested']
      ],
      primary: 'weight.gguf',
      mmproj: 'projector.gguf',
      other: 'keep'
    }
    const original = structuredClone(entry)
    const reference = vi.fn((name: string) => `/models/${name}`)
    expect(rewriteRegistryEntryReferences(entry, reference)).toEqual({
      ...entry,
      files: [
        '/models/weight.gguf',
        { name: '/models/projector.gguf', sha256: 'digest', role: 'projector' },
        null,
        42,
        {},
        { name: 7 },
        ['nested']
      ],
      primary: '/models/weight.gguf',
      mmproj: '/models/projector.gguf'
    })
    expect(entry).toEqual(original)
    expect(reference.mock.calls.flat()).toEqual([
      'weight.gguf',
      'projector.gguf',
      'weight.gguf',
      'projector.gguf'
    ])
    expect(rewriteRegistryEntryReferences({ primary: 'a', mmproj: 'b' }, reference)).toEqual({
      primary: '/models/a',
      mmproj: '/models/b'
    })
    for (const value of [
      null,
      undefined,
      42,
      'entry',
      [],
      { files: 42, primary: null, mmproj: false },
      {}
    ]) {
      expect(rewriteRegistryEntryReferences(value, reference)).toEqual(value)
    }
  })
})

describe('Leave registry metadata', () => {
  it.each(['strings', 'objects', 'primary/mmproj'])(
    'preserves installed references for %s',
    (shape) => {
      const f = fixture()
      fs.writeFileSync(path.join(f.source, 'projector.gguf'), 'projector')
      const names = ['weight.gguf', 'projector.gguf']
      const fields =
        shape === 'primary/mmproj'
          ? { primary: names[0], mmproj: names[1] }
          : {
              files: shape === 'strings' ? names : names.map((name) => ({ name, sha256: 'digest' }))
            }
      const entry = { id: 'fixture', name: 'Fixture', kind: 'vision', ...fields }
      const bytes = JSON.stringify([entry])
      fs.writeFileSync(path.join(f.source, 'downloaded-models.json'), bytes)
      // The ownership reader accepts all three historical registry shapes.
      expect(ownedStorageFiles(f.source, [])).toEqual(
        expect.arrayContaining(names.map((name) => expect.objectContaining({ name })))
      )
      leaveModelStorage(f.profile, f.source, f.destination)
      configureRuntime({ modelsDir: readModelStorageChoice(f.profile)! })
      const expected = names.map((name) => path.join(f.source, name))
      const rewritten = readDownloaded(f.destination)[0] as unknown as {
        files?: Array<string | { name: string; sha256: string }>
        primary?: string
        mmproj?: string
      }
      const references = rewritten.files
        ? rewritten.files.map((file) => (typeof file === 'string' ? file : file.name))
        : [rewritten.primary!, rewritten.mmproj!]
      expect(references).toEqual(expected)
      if (shape === 'objects') {
        expect(rewritten.files).toEqual(expected.map((name) => ({ name, sha256: 'digest' })))
      }
      if (shape === 'strings') expect(installedDownloadedIds(f.destination)).toEqual(['fixture'])
      for (const reference of references) {
        expect(modelPaths.resolveModelReference(reference)).toBe(reference)
        expect(fs.statSync(reference).size).toBeGreaterThan(0)
        expect(fs.existsSync(path.join(f.destination, path.basename(reference)))).toBe(false)
      }
      expect(fs.readFileSync(path.join(f.source, 'downloaded-models.json'), 'utf8')).toBe(bytes)
      expect(readPendingModelCleanup(f.profile)).toEqual([])
    }
  )

  it.each([
    ['downloaded-models.json', '{private broken json'],
    ['downloaded-models.json', '{"files":[]}'],
    ['downloaded-models.json', '[{"files":42}]'],
    ['downloaded-models.json', '[null,42,"private"]'],
    ['downloaded-models.json', '[{"files":[null,{"name":42}]}]'],
    ['local-models.json', '[{"primary":"weight.gguf"},{"files":42}]'],
    ['local-models.json', 'null'],
    ['active-model.json', '{broken'],
    ['active-model.json', '[]'],
    ['llm-settings.json', 'false']
  ])('copies malformed %s unchanged (%s)', (name, bytes) => {
    const f = fixture()
    fs.writeFileSync(path.join(f.source, name), bytes)
    // A failed file transform must not prevent other metadata from being copied.
    fs.writeFileSync(path.join(f.source, 'remote-vision-server.json'), '{"keep":true}')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    expect(() => leaveModelStorage(f.profile, f.source, f.destination)).not.toThrow()
    expect(fs.readFileSync(path.join(f.destination, name), 'utf8')).toBe(bytes)
    expect(warn).toHaveBeenCalledExactlyOnceWith(
      '[model-storage] Could not rewrite metadata; copying unchanged:',
      name
    )
    expect(fs.readFileSync(path.join(f.destination, 'remote-vision-server.json'), 'utf8')).toBe(
      '{"keep":true}'
    )
    expect(readModelStorageChoice(f.profile)).toBe(f.destination)
    expect(fs.readFileSync(path.join(f.source, 'weight.gguf'), 'utf8')).toBe('weights')
  })

  it('copies the original bytes if reference resolution throws after a partial transform', () => {
    const f = fixture()
    const bytes = '[ {"files":["weight.gguf","projector.gguf"]} ]'
    fs.writeFileSync(path.join(f.source, 'downloaded-models.json'), bytes)
    vi.spyOn(modelPaths, 'resolveModelReference')
      .mockReturnValueOnce('/rewritten/weight.gguf')
      .mockImplementationOnce(() => {
        throw new Error('private resolver detail')
      })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    expect(() => leaveModelStorage(f.profile, f.source, f.destination)).not.toThrow()
    expect(fs.readFileSync(path.join(f.destination, 'downloaded-models.json'), 'utf8')).toBe(bytes)
    expect(warn).toHaveBeenCalledExactlyOnceWith(
      '[model-storage] Could not rewrite metadata; copying unchanged:',
      'downloaded-models.json'
    )
  })
})
