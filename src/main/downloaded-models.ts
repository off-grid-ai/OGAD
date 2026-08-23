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
import { modelPackageIdentity } from '@offgrid/sync'
import { isProjectorFileName } from './models/catalog-logic'

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
    const arr = JSON.parse(fs.readFileSync(registryPath(dir), 'utf-8'))
    return Array.isArray(arr) ? (arr as DownloadedModel[]) : []
  } catch {
    return []
  }
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
  let changed = false
  const migrated: DownloadedModel[] = []
  for (const model of current) {
    if (model.familyId || model.packageIdentity) {
      migrated.push(model)
      continue
    }
    const family = catalog.find((entry) => entry.id === model.id)
    if (!family) {
      migrated.push(model)
      continue
    }
    const expected = new Set(family.files.map((file) => file.name))
    if (expected.size === model.files.length && model.files.every((name) => expected.has(name))) {
      changed = true
      continue
    }
    const files = model.files.map((name) => {
      let sizeBytes = 0
      try {
        sizeBytes = fs.statSync(path.join(dir, name)).size
      } catch {
        /* keep the legacy row until its package is complete */
      }
      return {
        name,
        sizeBytes,
        role: isProjectorFileName(name) ? ('projector' as const) : ('primary' as const)
      }
    })
    if (files.some((file) => file.sizeBytes <= 0)) {
      migrated.push(model)
      continue
    }
    const packageIdentity = modelPackageIdentity({
      id: model.id,
      name: model.name,
      kind: model.kind,
      source: 'downloaded',
      files: files as [(typeof files)[number], ...Array<(typeof files)[number]>],
      engine: model.kind === 'text' || model.kind === 'vision' ? 'llama' : undefined
    })
    migrated.push({
      ...model,
      id: packageIdentity,
      familyId: model.id,
      packageIdentity
    })
    changed = true
  }
  const unique = [...new Map(migrated.map((model) => [model.id, model])).values()]
  if (changed || unique.length !== current.length) writeDownloaded(dir, unique)
  return unique
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
            return fs.statSync(path.join(dir, f)).size > 0
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
