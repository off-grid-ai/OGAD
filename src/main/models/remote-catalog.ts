// The recommended-model catalog this app fetches from OGAD's catalog/models.json, so a new
// curated model reaches every install without a release. The copy of that file this build shipped
// with is the default, so a fresh install recommends from it offline: the app fetches only when
// someone asks (Check for new models) and keeps what it got, when it is newer. Fetch, validation and merge live in @offgrid/models; this file supplies the ports (fetch,
// a cache file in userData) and keeps the merged list in memory for the synchronous callers. No
// electron import: the transcription runner reads catalogModelsByKind() outside the app and
// gets the bundled list.

import fs from 'node:fs'
import path from 'node:path'
import {
  CATALOG,
  DESKTOP_CATALOG_URL,
  loadCachedCatalog,
  mergeCatalogEntries,
  modelSupportsKind,
  parseCatalogEnvelope,
  parseDesktopCatalogSections,
  refreshRemoteCatalog,
  type CatalogCache,
  type DesktopCatalogSections,
  type ModelEntry,
  type ModelKind,
  type RemoteCatalogSource
} from '@offgrid/models'
import shippedCatalog from '../../../catalog/models.json'

export interface CatalogCheckResult {
  status: 'updated' | 'unchanged' | 'failed'
  /** Models this check added that the app did not list before. */
  newModels: number
  error?: string
}

/** catalog/models.json as this build shipped it. */
const shipped = parseCatalogEnvelope(shippedCatalog, parseDesktopCatalogSections)

let remoteModels: ModelEntry[] = shipped?.sections.models ?? []
let source: RemoteCatalogSource<DesktopCatalogSections> | null = null
let inFlight: Promise<CatalogCheckResult> | null = null
let changed: () => void = () => undefined

/** The entries the last check fetched. */
export function remoteCatalogModels(): readonly ModelEntry[] {
  return remoteModels
}

/** Bundled shared catalog with the fetched entries merged over it. */
export function baseCatalogModels(): ModelEntry[] {
  return mergeCatalogEntries(CATALOG, remoteModels, (model) => model.id)
}

export function catalogModelsByKind(kind: ModelKind): ModelEntry[] {
  return baseCatalogModels().filter((model) => modelSupportsKind(model, kind))
}

function fileCache(file: string): CatalogCache {
  return {
    read: () => fs.promises.readFile(file, 'utf-8').catch(() => null),
    write: async (raw) => {
      const tmp = `${file}.tmp`
      await fs.promises.writeFile(tmp, raw, 'utf-8')
      await fs.promises.rename(tmp, file)
    }
  }
}

/** Loads the catalog a previous check saved. Never fetches. */
export async function initRemoteModelCatalog(
  userDataDir: string,
  onChanged: () => void
): Promise<void> {
  changed = onChanged
  source = {
    url: process.env.OFFGRID_MODEL_CATALOG_URL || DESKTOP_CATALOG_URL,
    fetch: (url, init) => fetch(url, init),
    cache: fileCache(path.join(userDataDir, 'model-catalog.json')),
    parseSections: parseDesktopCatalogSections
  }
  const cached = await loadCachedCatalog(source)
  // A copy fetched before this build shipped is older than the one inside it.
  const newer = cached && (!shipped || cached.updatedAt >= shipped.updatedAt) ? cached : shipped
  remoteModels = newer?.sections.models ?? []
  if (remoteModels.length > 0) changed()
}

/** Fetches the catalog now. Concurrent calls share one request. */
export function checkForNewModels(): Promise<CatalogCheckResult> {
  const active = source
  if (!active) return Promise.resolve({ status: 'failed', newModels: 0, error: 'Not ready' })
  inFlight ??= (async () => {
    const before = new Set(baseCatalogModels().map((model) => model.id))
    const result = await refreshRemoteCatalog(active)
    if (result.status === 'failed') {
      return { status: 'failed' as const, newModels: 0, error: result.error }
    }
    remoteModels = result.catalog.sections.models ?? []
    const newModels = remoteModels.filter((model) => !before.has(model.id)).length
    if (result.status === 'updated') changed()
    return { status: result.status, newModels }
  })().finally(() => {
    inFlight = null
  })
  return inFlight
}
