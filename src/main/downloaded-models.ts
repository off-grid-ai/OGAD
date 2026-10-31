// Registry of free-form Hugging Face models the user downloaded (search bar), as
// opposed to catalog entries and locally-imported .gguf files. Without this, a
// downloaded HF model (e.g. MiniCPM-V) has its files on disk but nothing records
// it as installed, so it's flagged as "unused" and never offered as a usable
// option (the bug). Direct downloads keep their HF repo id. Device-transferred variants use the
// shared exact package identity and keep the HF/catalog family id as separate provenance. This lets
// Q4_0 and Q4_K_M from one repository coexist without either one replacing the other.
//
// Pure/IO-only + parameterized by the models dir, so it's testable against a real
// temp directory with real files (no Electron, no network, no mocks).

import fs from 'fs'
import path from 'path'
import { modelMetadataFile, modelReadDirectories, resolveModelReference } from './model-paths'
import { modelsDir } from './runtime-env'
import { modelPackageIdentity } from '@offgrid/sync'
import { extractQuantization, videoArchitecture, videoPackFiles } from '@offgrid/models'
import { isValidGgufFile } from './models/gguf'
import { isProjectorFileName } from './models/catalog-logic'
import { isImageModelFile } from './imagegen/model-filter'
import { readGgufContextLength } from './models/gguf-metadata'

/**
 * The role of a free-form download, judged from its files. A Hugging Face repo resolves to the
 * chat-engine default ('text', or 'vision' when a companion looks like a projector) because the
 * hub search does not carry the tab the user searched from. The image runtime already decides
 * which weights are image models by filename (isImageModelFile); a download whose primary weight
 * is one of those, and which ships no real mmproj projector, is an image model everywhere else
 * too. Any other declared role is kept.
 *
 * The filename families are broad (turbo, lightning, anything...), so when `roots` locate the
 * weight on disk, a GGUF that declares a trained context length is a language model whatever its
 * name says. This is a read-time judgement and is never written back to the registry.
 */
export function downloadedModelKind<K extends string>(
  kind: K,
  files: readonly string[],
  roots?: string[]
): K | 'image' {
  if (kind !== 'text' && kind !== 'vision') return kind
  if (files.some((name) => isProjectorFileName(name))) return kind
  const primary = files[0]
  if (!primary || !isImageModelFile(path.basename(primary))) return kind
  if (
    roots &&
    /\.gguf$/i.test(primary) &&
    readGgufContextLength(resolveModelReference(primary, roots), fs) !== null
  )
    return kind
  return 'image'
}

export interface DownloadedModel {
  /** Exact installed variant key. Legacy entries use the Hugging Face family id. */
  id: string
  /** Human/catalog family identity used for display and upstream repair. */
  familyId?: string
  /** Deterministic runnable-package identity for device-transferred variants. */
  packageIdentity?: string
  name: string
  kind: string
  /** On-disk filenames this model comprises (primary + any mmproj/companions). */
  files: string[]
}

function registryPath(dir: string): string {
  return path.join(dir, 'downloaded-models.json')
}

export function readDownloaded(dir: string): DownloadedModel[] {
  try {
    const arr = JSON.parse(
      fs.readFileSync(
        modelMetadataFile(
          'downloaded-models.json',
          dir === modelsDir() ? modelReadDirectories() : [dir]
        ),
        'utf-8'
      )
    )
    return Array.isArray(arr) ? arr.flatMap(usableDownloadedModel) : []
  } catch {
    return []
  }
}

/** A registry copied or edited by hand can hold rows without an id, or without a file list. A row
 *  without an id names no model, so readers skip it. Older rows name their files only as primary
 *  and mmproj; readers get those as the file list, so no row makes every model read fail. */
function usableDownloadedModel(value: unknown): DownloadedModel[] {
  if (typeof value !== 'object' || value === null) return []
  const entry = value as Partial<DownloadedModel> & { primary?: unknown; mmproj?: unknown }
  if (typeof entry.id !== 'string') return []
  if (Array.isArray(entry.files)) return [entry as DownloadedModel]
  const files = [entry.primary, entry.mmproj].filter(
    (file): file is string => typeof file === 'string'
  )
  return [{ ...entry, files } as DownloadedModel]
}

function writeDownloaded(dir: string, list: DownloadedModel[]): void {
  try {
    fs.writeFileSync(registryPath(dir), JSON.stringify(list, null, 2))
  } catch {
    /* best effort */
  }
}

export interface DownloadedRegistryCatalogEntry {
  id: string
  name?: string
  kind?: string
  files: Array<{ name: string }>
}

/**
 * Migrate the old catalog-family alias used by transferred variants.
 *
 * Older receivers stored an alternate quant/projector package under its catalog family id. That
 * made activation resolve the catalog files and made the UI project both rows. The migration gives
 * an alternate package its exact shared identity and keeps the family separately. An entry whose
 * files exactly match the catalog is redundant and is removed from the registry only; model files
 * are never deleted here.
 */
export function reconcileDownloadedModelRegistry(
  dir: string,
  catalog: readonly DownloadedRegistryCatalogEntry[]
): DownloadedModel[] {
  const current = readDownloaded(dir)
  const roots = dir === modelsDir() ? modelReadDirectories() : [dir]
  // Older builds recorded every free-form GGUF download as 'text', including image weights, and
  // later builds wrote the filename guess back as 'image', which also caught chat models named
  // e.g. "turbo". The role shown to Storage, the per-kind tabs and the chat model lists is judged
  // here on every read and never persisted, so a wrong guess corrects itself. A free-form download
  // (no catalog family or package identity) only ever had 'image' from that guess; catalog and
  // transferred entries keep the role they were recorded with.
  const readKind = (model: DownloadedModel): string => {
    const guessed = !model.familyId && !model.packageIdentity && model.kind === 'image'
    return downloadedModelKind(guessed ? 'text' : model.kind, model.files, roots)
  }
  const viewOf = new Map<DownloadedModel, DownloadedModel>()
  const withReadKind = (model: DownloadedModel): DownloadedModel => {
    const kind = readKind(model)
    const view = kind === model.kind ? model : { ...model, kind }
    viewOf.set(model, view)
    return model
  }
  // A catalog video entry whose exact pack these files are: its own row already lists them.
  const catalogVideoPack = (names: readonly string[]): boolean =>
    catalog.some(
      (entry) =>
        entry.kind === 'video' &&
        entry.files.length === names.length &&
        names.every((name) => entry.files.some((file) => file.name === name))
    )
  let changed = false
  const migrated: DownloadedModel[] = []
  for (const model of current) {
    // An adopted video copy that is some catalog entry's exact pack showed the same files twice.
    // Only the registry row goes; the files stay.
    if (model.kind === 'video' && model.packageIdentity && catalogVideoPack(model.files)) {
      changed = true
      continue
    }
    if (model.familyId || model.packageIdentity) {
      const family = model.familyId
        ? catalog.find((entry) => entry.id === model.familyId)
        : undefined
      // A model can gain a more precise catalog role after it was downloaded or transferred.
      // Keep the legacy package identity stable so synced references do not break, but repair the
      // local role used by catalog grouping and activation gates.
      if (family?.kind && model.kind !== family.kind) {
        migrated.push({ ...model, kind: family.kind })
        changed = true
      } else {
        migrated.push(family?.kind ? model : withReadKind(model))
      }
      continue
    }
    const family = catalog.find((entry) => entry.id === model.id)
    if (!family) {
      migrated.push(withReadKind(model))
      continue
    }
    const expected = new Set(family.files.map((file) => resolveModelReference(file.name, roots)))
    if (
      expected.size === model.files.length &&
      model.files.every((name) => expected.has(resolveModelReference(name, roots)))
    ) {
      changed = true
      continue
    }
    const files = model.files.map((name) => {
      let sizeBytes = 0
      try {
        sizeBytes = fs.statSync(resolveModelReference(name, roots)).size
      } catch {
        /* keep the legacy row until its package is complete */
      }
      return {
        name: path.isAbsolute(name) ? path.basename(name) : name,
        sizeBytes,
        role: isProjectorFileName(name) ? ('projector' as const) : ('primary' as const)
      }
    })
    if (files.some((file) => file.sizeBytes <= 0)) {
      migrated.push(withReadKind(model))
      continue
    }
    const kind = readKind(model)
    const packageIdentity = modelPackageIdentity({
      id: model.id,
      name: model.name,
      kind,
      source: 'downloaded',
      files: files as [(typeof files)[number], ...Array<(typeof files)[number]>],
      engine: kind === 'text' || kind === 'vision' ? 'llama' : undefined
    })
    const migratedModel = { ...model, id: packageIdentity, familyId: model.id, packageIdentity }
    migrated.push(migratedModel)
    viewOf.set(migratedModel, kind === model.kind ? migratedModel : { ...migratedModel, kind })
    changed = true
  }
  // Adopt complete copied video variants into the existing package registry.
  // Their normal Use/Delete/Transfer controls must use the same identity as downloads.
  let entries: string[] = []
  try { entries = fs.readdirSync(dir) } catch { /* no model directory yet */ }
  for (const weight of entries) {
    const architecture = videoArchitecture(weight)
    if (!architecture || migrated.some((model) => model.kind === 'video' && model.files.includes(weight))) continue
    const names = Object.values(videoPackFiles(weight)!)
    // The catalog already provides controls when this is any entry's exact default pack.
    if (catalogVideoPack(names)) continue
    const family = catalog.find((entry) => entry.kind === 'video' &&
      entry.files.some((file) => videoArchitecture(file.name) === architecture))
    if (!family) continue
    const files: Array<{ name: string; sizeBytes: number; role: 'primary' }> = []
    for (const name of names) {
      try {
        const filePath = path.join(dir, name)
        const stat = fs.lstatSync(filePath)
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0 ||
          (name.endsWith('.gguf') && !isValidGgufFile(filePath, fs))) break
        files.push({ name, sizeBytes: stat.size, role: 'primary' })
      } catch { break }
    }
    if (files.length !== names.length) continue
    const name = `${family.name ?? 'Video model'} · ${extractQuantization(weight)}`
    const packageIdentity = modelPackageIdentity({
      id: family.id, name, kind: 'video', source: 'downloaded',
      files: files as [(typeof files)[number], ...typeof files]
    })
    migrated.push({ id: packageIdentity, familyId: family.id, packageIdentity,
      name, kind: 'video', files: names })
    changed = true
  }

  const unique = [...new Map(migrated.map((model) => [model.id, model])).values()]
  if (changed || unique.length !== current.length) writeDownloaded(dir, unique)
  return unique.map((model) => viewOf.get(model) ?? model)
}

/** Record a downloaded model (replacing any existing entry with the same id). */
export function recordDownloaded(dir: string, model: DownloadedModel): void {
  const next = readDownloaded(dir).filter((m) => m.id !== model.id)
  next.push(model)
  writeDownloaded(dir, next)
}

/** Drop a downloaded model from the registry (after its files are deleted). */
export function removeDownloaded(dir: string, id: string): void {
  writeDownloaded(
    dir,
    readDownloaded(dir).filter((m) => m.id !== id)
  )
}

/** A downloaded model looked up by id (or undefined). */
export function findDownloaded(dir: string, id: string): DownloadedModel | undefined {
  return readDownloaded(dir).find((m) => m.id === id)
}

/** Ids of downloaded models whose every file is present on disk (size > 0). A
 *  partially-deleted model is NOT installed. */
export function installedDownloadedIds(dir: string): string[] {
  return readDownloaded(dir)
    .filter(
      (m) =>
        m.files.length > 0 &&
        m.files.every((f) => {
          try {
            return (
              fs.statSync(
                resolveModelReference(f, dir === modelsDir() ? modelReadDirectories() : [dir])
              ).size > 0
            )
          } catch {
            return false
          }
        })
    )
    .map((m) => m.id)
}

/** Every filename referenced by the downloaded registry, so storage/orphan logic
 *  never flags a downloaded model as an "unused file". */
export function downloadedProtectedNames(dir: string): Set<string> {
  const s = new Set<string>()
  for (const m of readDownloaded(dir)) for (const f of m.files) s.add(f)
  return s
}
