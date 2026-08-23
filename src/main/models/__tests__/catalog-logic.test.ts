// Exhaustive unit tests for the pure catalog/install/storage decision logic. Real
// in-memory inputs, injected FS probes - no mocks, no disk. Each case covers one
// branch of the logic extracted from models-manager.ts. The load-bearing rule these
// guard: all THREE model sources (imported local, free-form HF download, catalog)
// stay surfaced, in that order, with the exact per-source predicates.

import { describe, it, expect } from 'vitest'
import {
  localsForCatalog,
  downloadedForCatalog,
  mergeCatalog,
  catalogEntryInstalled,
  installedIds,
  primaryFileName,
  buildDiskEntry,
  protectedNames,
  scanModelDir,
  modalityForModel,
  isModalKind,
  modalSelectionMatches,
  isChatLoadable,
  projectorFileName,
  visionStatus,
  projectorToHeal,
  type CatalogEntry,
  type LocalModelLike,
  type DownloadedModelLike
} from '../catalog-logic'
import { modalityForKind } from '../../active-models'

const local: LocalModelLike = {
  id: 'local:my.gguf',
  name: 'my',
  primary: 'my.gguf',
  kind: 'text',
  sizeBytes: 100
}
const localVision: LocalModelLike = {
  id: 'local:v.gguf',
  name: 'v',
  primary: 'v.gguf',
  mmproj: 'v-mmproj.gguf',
  kind: 'vision',
  sizeBytes: 200
}
const dl: DownloadedModelLike = {
  id: 'org/hf',
  name: 'HF',
  kind: 'vision',
  files: ['hf.gguf', 'hf-mmproj.gguf']
}
const catEntry: CatalogEntry = {
  id: 'cat/text',
  name: 'Cat Text',
  kind: 'text',
  files: [{ name: 'cat.gguf', role: 'primary' }]
}
const catMflux: CatalogEntry = {
  id: 'cat/mflux',
  name: 'Flux',
  kind: 'image',
  runtime: 'mflux',
  files: []
}

const presentAll = (): boolean => true
const presentNone = (): boolean => false
const presentOnly =
  (names: string[]) =>
  (n: string): boolean =>
    names.includes(n)

describe('localsForCatalog', () => {
  it('includes locals whose primary file is present, tagged Imported, org Local', () => {
    const out = localsForCatalog([local], presentAll)
    expect(out).toEqual([
      {
        id: 'local:my.gguf',
        name: 'my',
        kind: 'text',
        org: 'Local',
        params: undefined,
        tags: ['Imported'],
        files: [{ name: 'my.gguf', url: '', sizeBytes: 100 }]
      }
    ])
  })
  it('drops a local whose primary file is missing', () => {
    expect(localsForCatalog([local], presentNone)).toEqual([])
  })
  it('returns [] for no locals', () => {
    expect(localsForCatalog([], presentAll)).toEqual([])
  })
})

describe('downloadedForCatalog', () => {
  it('includes only fully-installed downloads, tagged Downloaded, org Hugging Face', () => {
    const out = downloadedForCatalog([dl], ['org/hf'])
    expect(out).toEqual([
      {
        id: 'org/hf',
        name: 'HF',
        kind: 'vision',
        org: 'Hugging Face',
        tags: ['Downloaded'],
        files: [
          { name: 'hf.gguf', url: '', role: 'primary' },
          { name: 'hf-mmproj.gguf', url: '', role: 'mmproj' }
        ]
      }
    ])
  })
  it('excludes a download not in the installed set', () => {
    expect(downloadedForCatalog([dl], [])).toEqual([])
  })
  it('returns [] for no downloads', () => {
    expect(downloadedForCatalog([], ['org/hf'])).toEqual([])
  })
})

describe('mergeCatalog — order + all three sources', () => {
  it('emits locals, then installed downloads, then the catalog, in that order', () => {
    const out = mergeCatalog({
      locals: [local],
      downloaded: [dl],
      installedDownloadedIds: ['org/hf'],
      catalog: [catEntry],
      present: presentAll
    })
    expect(out.map((m) => m.id)).toEqual(['local:my.gguf', 'org/hf', 'cat/text'])
    expect(out[0]!.tags).toEqual(['Imported'])
    expect(out[1]!.tags).toEqual(['Downloaded'])
    expect(out[2]).toBe(catEntry)
  })
  it('empty locals + empty downloads => just the catalog', () => {
    const out = mergeCatalog({
      locals: [],
      downloaded: [],
      installedDownloadedIds: [],
      catalog: [catEntry],
      present: presentAll
    })
    expect(out).toEqual([catEntry])
  })
  it('a not-installed download is omitted even if in the registry', () => {
    const out = mergeCatalog({
      locals: [],
      downloaded: [dl],
      installedDownloadedIds: [],
      catalog: [],
      present: presentAll
    })
    expect(out).toEqual([])
  })
  it('projects one installed row when an exact variant represents a catalog family', () => {
    const variant = { ...dl, id: 'model-package-v1:exact', familyId: catEntry.id }
    const out = mergeCatalog({
      locals: [],
      downloaded: [variant],
      installedDownloadedIds: [variant.id],
      catalog: [catEntry],
      present: presentAll
    })
    expect(out.map((model) => model.id)).toEqual([variant.id])
    expect(out[0]!.files.find((file) => file.role === 'mmproj')?.name).toBe('hf-mmproj.gguf')
  })
})

describe('catalogEntryInstalled', () => {
  it('true when every file present', () => {
    expect(catalogEntryInstalled(catEntry, presentAll, () => false)).toBe(true)
  })
  it('false when a file is missing', () => {
    expect(catalogEntryInstalled(catEntry, presentNone, () => false)).toBe(false)
  })
  it('false when the entry has zero files (non-mflux)', () => {
    expect(catalogEntryInstalled({ ...catEntry, files: [] }, presentAll, () => false)).toBe(false)
  })
  it('mflux entry defers to the runtime cache: cached => installed', () => {
    expect(catalogEntryInstalled(catMflux, presentNone, (id) => id === 'cat/mflux')).toBe(true)
  })
  it('mflux entry not cached => not installed (ignores files)', () => {
    expect(catalogEntryInstalled(catMflux, presentAll, () => false)).toBe(false)
  })
})

describe('installedIds — order + per-source predicate', () => {
  it('locals, then downloaded, then present catalog ids', () => {
    const out = installedIds({
      locals: [local],
      installedDownloadedIds: ['org/hf'],
      catalog: [catEntry],
      present: presentAll,
      mfluxCached: () => false
    })
    expect(out).toEqual(['local:my.gguf', 'org/hf', 'cat/text'])
  })
  it('drops a local whose file is gone; keeps a present catalog id', () => {
    const out = installedIds({
      locals: [local],
      installedDownloadedIds: [],
      catalog: [catEntry],
      present: presentOnly(['cat.gguf']),
      mfluxCached: () => false
    })
    expect(out).toEqual(['cat/text'])
  })
  it('does not list the catalog alias beside an installed exact family variant', () => {
    const variant = { ...dl, id: 'model-package-v1:exact', familyId: catEntry.id }
    expect(
      installedIds({
        locals: [],
        installedDownloadedIds: [variant.id],
        downloaded: [variant],
        catalog: [catEntry],
        present: presentAll,
        mfluxCached: () => false
      })
    ).toEqual([variant.id])
  })
  it('includes an mflux id only when cached', () => {
    const both = installedIds({
      locals: [],
      installedDownloadedIds: [],
      catalog: [catMflux],
      present: presentNone,
      mfluxCached: () => true
    })
    const none = installedIds({
      locals: [],
      installedDownloadedIds: [],
      catalog: [catMflux],
      present: presentAll,
      mfluxCached: () => false
    })
    expect(both).toEqual(['cat/mflux'])
    expect(none).toEqual([])
  })
})

describe('primaryFileName', () => {
  it('prefers the role:primary file', () => {
    expect(
      primaryFileName({ files: [{ name: 'a.gguf' }, { name: 'p.gguf', role: 'primary' }] })
    ).toBe('p.gguf')
  })
  it('falls back to the first file when none is role:primary', () => {
    expect(primaryFileName({ files: [{ name: 'a.gguf' }, { name: 'b.gguf' }] })).toBe('a.gguf')
  })
  it('undefined for no files', () => {
    expect(primaryFileName({ files: [] })).toBeUndefined()
  })
})

describe('buildDiskEntry — source resolution + active flag', () => {
  const sizeOf = (name: string): number =>
    (
      ({
        'my.gguf': 100,
        'v.gguf': 200,
        'v-mmproj.gguf': 50,
        'hf.gguf': 300,
        'hf-mmproj.gguf': 60,
        'cat.gguf': 400
      }) as Record<string, number>
    )[name] ?? 0
  const noModals = { image: null, speech: null, transcription: null }

  it('imported local: sums primary + mmproj, kind local, active when it is the chat id', () => {
    const e = buildDiskEntry({
      id: 'local:v.gguf',
      locals: [localVision],
      downloaded: [],
      catalogById: () => undefined,
      isCatalogId: () => false,
      activeChatId: 'local:v.gguf',
      modals: noModals,
      sizeOf
    })
    expect(e).toEqual({ id: 'local:v.gguf', name: 'v', kind: 'local', bytes: 250, active: true })
  })
  it('imported local: not active when it is not the chat id', () => {
    const e = buildDiskEntry({
      id: 'local:my.gguf',
      locals: [local],
      downloaded: [],
      catalogById: () => undefined,
      isCatalogId: () => false,
      activeChatId: null,
      modals: noModals,
      sizeOf
    })
    expect(e).toMatchObject({ kind: 'local', bytes: 100, active: false })
  })
  it('free-form download: reads kind/files from the registry, active by modality filename match', () => {
    const e = buildDiskEntry({
      id: 'org/hf',
      locals: [],
      downloaded: [dl],
      catalogById: () => undefined,
      isCatalogId: () => false,
      activeChatId: null,
      modals: { image: null, speech: null, transcription: null },
      sizeOf
    })
    // vision => chat LLM path (not a modality), so not active unless it is the chat id.
    expect(e).toEqual({ id: 'org/hf', name: 'HF', kind: 'vision', bytes: 360, active: false })
  })
  it('download id that IS also a catalog id falls through to the catalog branch', () => {
    const e = buildDiskEntry({
      id: 'org/hf',
      locals: [],
      downloaded: [dl],
      catalogById: (id) =>
        id === 'org/hf' ? { ...catEntry, id: 'org/hf', name: 'FromCatalog' } : undefined,
      isCatalogId: (id) => id === 'org/hf',
      activeChatId: null,
      modals: noModals,
      sizeOf
    })
    expect(e.name).toBe('FromCatalog')
  })
  it('catalog model: sums catalog files, name/kind from the entry', () => {
    const e = buildDiskEntry({
      id: 'cat/text',
      locals: [],
      downloaded: [],
      catalogById: (id) => (id === 'cat/text' ? catEntry : undefined),
      isCatalogId: (id) => id === 'cat/text',
      activeChatId: 'cat/text',
      modals: noModals,
      sizeOf
    })
    expect(e).toEqual({ id: 'cat/text', name: 'Cat Text', kind: 'text', bytes: 400, active: true })
  })
  it('unknown id (no source): name falls back to the id, bytes 0, inactive', () => {
    const e = buildDiskEntry({
      id: 'ghost',
      locals: [],
      downloaded: [],
      catalogById: () => undefined,
      isCatalogId: () => false,
      activeChatId: null,
      modals: noModals,
      sizeOf
    })
    expect(e).toEqual({ id: 'ghost', name: 'ghost', kind: undefined, bytes: 0, active: false })
  })
  it('image catalog model is active when a modality pick matches its primary filename', () => {
    const img: CatalogEntry = {
      id: 'cat/img',
      name: 'Img',
      kind: 'image',
      files: [{ name: 'img.safetensors', role: 'primary' }]
    }
    const e = buildDiskEntry({
      id: 'cat/img',
      locals: [],
      downloaded: [],
      catalogById: () => img,
      isCatalogId: () => true,
      activeChatId: null,
      modals: { image: 'img.safetensors', speech: null, transcription: null },
      sizeOf: () => 0
    })
    expect(e.active).toBe(true)
  })
})

describe('protectedNames — orphan protection', () => {
  it('unions catalog files, local names, downloaded names, and active primary+mmproj', () => {
    const known = protectedNames({
      catalog: [catEntry],
      localNames: ['my.gguf'],
      downloadedNames: ['hf.gguf', 'hf-mmproj.gguf'],
      activePrimary: 'active.gguf',
      activeMmproj: 'active-mmproj.gguf'
    })
    expect([...known].sort()).toEqual([
      'active-mmproj.gguf',
      'active.gguf',
      'cat.gguf',
      'hf-mmproj.gguf',
      'hf.gguf',
      'my.gguf'
    ])
  })
  it('ignores null/absent active selection', () => {
    const known = protectedNames({
      catalog: [],
      localNames: [],
      downloadedNames: [],
      activePrimary: null,
      activeMmproj: null
    })
    expect(known.size).toBe(0)
  })
})

describe('scanModelDir — total + orphans', () => {
  const stat = (sizes: Record<string, number>) => (name: string) =>
    name in sizes ? { isFile: true, size: sizes[name]! } : null
  it('sums .gguf/.part sizes and flags unknown files as orphans', () => {
    const known = new Set(['keep.gguf'])
    const out = scanModelDir({
      entries: ['keep.gguf', 'stray.gguf', 'keep.gguf.part', 'notes.txt'],
      known,
      statFile: stat({ 'keep.gguf': 10, 'stray.gguf': 20, 'keep.gguf.part': 5, 'notes.txt': 1 })
    })
    // notes.txt ignored (not gguf/part); .part strips suffix so keep.gguf.part is known.
    expect(out.totalBytes).toBe(35)
    expect(out.orphans).toEqual([{ name: 'stray.gguf', bytes: 20 }])
  })
  it('skips non-files and unstattable entries', () => {
    const out = scanModelDir({
      entries: ['dir.gguf', 'gone.gguf'],
      known: new Set(),
      statFile: (n) => (n === 'dir.gguf' ? { isFile: false, size: 999 } : null)
    })
    expect(out.totalBytes).toBe(0)
    expect(out.orphans).toEqual([])
  })
  it('an unknown .part is an orphan (matched by its bare name)', () => {
    const out = scanModelDir({
      entries: ['half.gguf.part'],
      known: new Set(['other.gguf']),
      statFile: stat({ 'half.gguf.part': 7 })
    })
    expect(out.orphans).toEqual([{ name: 'half.gguf.part', bytes: 7 }])
  })
})

describe('dispatch predicates', () => {
  it('modalityForModel delegates to the single source of truth (active-models)', () => {
    for (const k of ['image', 'voice', 'transcription', 'text', 'vision', 'local', undefined]) {
      expect(modalityForModel(k)).toBe(modalityForKind(k))
    }
  })
  it('isModalKind is true only for image/speech/transcription', () => {
    expect(isModalKind('image')).toBe(true)
    expect(isModalKind('speech')).toBe(true)
    expect(isModalKind('transcription')).toBe(true)
    expect(isModalKind('text')).toBe(false)
    expect(isModalKind('voice')).toBe(false)
  })
  it('modalSelectionMatches matches by id AND by primary filename (D6)', () => {
    // image picks are stored by FILENAME, so deleting by id must still match.
    expect(
      modalSelectionMatches(
        'juggernaut-xl.safetensors',
        'juggernaut-xl',
        'juggernaut-xl.safetensors'
      )
    ).toBe(true)
    expect(modalSelectionMatches('kokoro', 'kokoro', 'kokoro.onnx')).toBe(true) // stored by id
    expect(
      modalSelectionMatches('other.safetensors', 'juggernaut-xl', 'juggernaut-xl.safetensors')
    ).toBe(false)
    expect(modalSelectionMatches(null, 'juggernaut-xl', 'juggernaut-xl.safetensors')).toBe(false)
    expect(modalSelectionMatches('juggernaut-xl', 'juggernaut-xl', null)).toBe(true)
  })
  it('isChatLoadable is true only for text/vision', () => {
    expect(isChatLoadable('text')).toBe(true)
    expect(isChatLoadable('vision')).toBe(true)
    expect(isChatLoadable('image')).toBe(false)
    expect(isChatLoadable('voice')).toBe(false)
    expect(isChatLoadable('transcription')).toBe(false)
  })

  describe('vision status (derived capability + projector readiness)', () => {
    const primary = { name: 'w.gguf', role: 'primary' }
    const proj = { name: 'mmproj.gguf', role: 'mmproj' }

    it('projectorFileName returns the mmproj file name, else undefined', () => {
      expect(projectorFileName({ files: [primary, proj] })).toBe('mmproj.gguf')
      expect(projectorFileName({ files: [primary] })).toBeUndefined()
    })

    it('a text-only model neither supports vision nor has a projector', () => {
      expect(visionStatus({ files: [primary] }, () => true)).toEqual({
        supportsVision: false,
        projectorInstalled: false
      })
    })

    it('a vision model with its projector on disk is ready', () => {
      const present = (n: string): boolean => n === 'mmproj.gguf'
      expect(visionStatus({ files: [primary, proj] }, present)).toEqual({
        supportsVision: true,
        projectorInstalled: true
      })
    })

    it('a vision model whose projector is MISSING supports vision but is not ready', () => {
      // The exact "download vision support" case: installed model, can see, projector
      // not yet fetched.
      expect(visionStatus({ files: [primary, proj] }, () => false)).toEqual({
        supportsVision: true,
        projectorInstalled: false
      })
    })
  })

  describe('projectorToHeal (stale active-model.json recovery)', () => {
    const primary = { name: 'w.gguf', role: 'primary' }
    const proj = { name: 'mmproj.gguf', role: 'mmproj' }
    const entry = { files: [primary, proj] }
    const onDisk = (n: string): boolean => n === 'mmproj.gguf'

    it('heals a null-projector config once the projector is on disk', () => {
      // Gemma 4 E2B: activated with mmproj:null before the catalog had a projector;
      // once downloaded, hasVision must flip on without a manual re-activate.
      expect(projectorToHeal({ id: 'e2b', mmproj: null }, entry, onDisk)).toBe('mmproj.gguf')
    })

    it('leaves a config that already records a projector', () => {
      expect(projectorToHeal({ id: 'e2b', mmproj: 'mmproj.gguf' }, entry, onDisk)).toBeUndefined()
    })

    it('does nothing until the projector is actually downloaded', () => {
      expect(projectorToHeal({ id: 'e2b', mmproj: null }, entry, () => false)).toBeUndefined()
    })

    it('does nothing for a text-only model or when there is no active model', () => {
      expect(
        projectorToHeal({ id: 't', mmproj: null }, { files: [primary] }, onDisk)
      ).toBeUndefined()
      expect(projectorToHeal(null, entry, onDisk)).toBeUndefined()
      expect(projectorToHeal({ mmproj: null }, entry, onDisk)).toBeUndefined()
    })
  })
})
