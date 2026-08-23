// Pure decision logic for the model catalog/install/storage surface, extracted
// from models-manager.ts so it can be unit-tested WITHOUT Electron/fs. Every
// filesystem probe is INJECTED as a closure (fileExists / sizeOf), so these
// functions stay pure and are exercised against plain in-memory inputs - no
// mocks, no disk, no network.
//
// The three model sources this file preserves EXACTLY as the live app surfaces
// them, in this order:
//   1. imported local models  (getLocalModels, tagged "Imported")
//   2. free-form HF downloads  (readDownloaded, tagged "Downloaded")
//   3. catalog entries         (CATALOG)
// Any change here that drops or reorders a source is a regression.

import { modalityForKind, isModelActive, type Modality } from '../active-models'

// Minimal structural shapes so this module needs no runtime imports from
// @offgrid/models (which is async-imported in the IO shell). Callers pass the
// concrete objects; only these fields are read.
interface CatalogFile {
  name: string
  url?: string
  sizeBytes?: number
  role?: string
}
export interface CatalogEntry {
  id: string
  name: string
  kind: string
  org?: string
  params?: number
  tags?: string[]
  files: CatalogFile[]
  runtime?: string
}
export interface LocalModelLike {
  id: string
  name: string
  primary: string
  mmproj?: string
  kind: string
  params?: number
  sizeBytes: number
}
export interface DownloadedModelLike {
  id: string
  familyId?: string
  name: string
  kind: string
  files: string[]
}

/** A byte-size probe for a filename in the models dir; 0 when absent/unreadable. */
export type SizeOf = (name: string) => number
/** True when a filename exists on disk with size > 0. */
export type FilePresent = (name: string) => boolean

export const isProjectorFileName = (name: string): boolean =>
  /(?:^|[-_.])(mmproj|projector)(?:[-_.]|$)/i.test(name)

/** A catalog-shaped view of an imported local model whose primary file is present
 *  (size > 0). Tagged "Imported" and surfaced at the top of the catalog. */
export function localsForCatalog(locals: LocalModelLike[], present: FilePresent): CatalogEntry[] {
  return locals
    .filter((lm) => present(lm.primary))
    .map((lm) => ({
      id: lm.id,
      name: lm.name,
      kind: lm.kind,
      org: 'Local',
      params: lm.params,
      tags: ['Imported'],
      files: [{ name: lm.primary, url: '', sizeBytes: lm.sizeBytes }]
    }))
}

/** A catalog-shaped view of the free-form HF downloads that are fully installed.
 *  `installedIds` is the set of downloaded ids whose every file is present. */
export function downloadedForCatalog(
  downloaded: DownloadedModelLike[],
  installedDownloadIds: Iterable<string>
): CatalogEntry[] {
  const installed = new Set(installedDownloadIds)
  return downloaded
    .filter((m) => installed.has(m.id))
    .map((m) => ({
      id: m.id,
      name: m.name,
      kind: m.kind,
      org: 'Hugging Face',
      tags: ['Downloaded'],
      files: m.files.map((name) => ({
        name,
        url: '',
        role: isProjectorFileName(name) ? 'mmproj' : 'primary'
      }))
    }))
}

/** The full merged catalog model list, in the exact live order:
 *  imported locals, then installed HF downloads, then the catalog. */
export function mergeCatalog(opts: {
  locals: LocalModelLike[]
  downloaded: DownloadedModelLike[]
  installedDownloadedIds: Iterable<string>
  catalog: CatalogEntry[]
  present: FilePresent
}): CatalogEntry[] {
  const installed = new Set(opts.installedDownloadedIds)
  const representedFamilies = new Set(
    opts.downloaded
      .filter((model) => installed.has(model.id))
      .map((model) => model.familyId)
      .filter((id): id is string => Boolean(id))
  )
  return [
    ...localsForCatalog(opts.locals, opts.present),
    ...downloadedForCatalog(opts.downloaded, opts.installedDownloadedIds),
    ...opts.catalog.filter((entry) => !representedFamilies.has(entry.id))
  ]
}

/** Whether a single catalog entry counts as installed. mflux entries defer to the
 *  runtime cache (`mfluxCached`); everything else needs every file present (size>0). */
export function catalogEntryInstalled(
  entry: CatalogEntry,
  present: FilePresent,
  mfluxCached: (id: string) => boolean
): boolean {
  if (entry.runtime === 'mflux') return mfluxCached(entry.id)
  return entry.files.length > 0 && entry.files.every((f) => present(f.name))
}

/** The installed-id list, in the exact live order: imported locals, installed HF
 *  downloads, then the catalog ids whose files are present (or mflux-cached). */
export function installedIds(opts: {
  locals: LocalModelLike[]
  installedDownloadedIds: Iterable<string>
  downloaded?: DownloadedModelLike[]
  catalog: CatalogEntry[]
  present: FilePresent
  mfluxCached: (id: string) => boolean
}): string[] {
  const downloadedIds = [...opts.installedDownloadedIds]
  const installed = new Set(downloadedIds)
  const representedFamilies = new Set(
    (opts.downloaded ?? [])
      .filter((model) => installed.has(model.id))
      .map((model) => model.familyId)
      .filter((id): id is string => Boolean(id))
  )
  const catalog = opts.catalog
    .filter((model) => !representedFamilies.has(model.id))
    .filter((m) => catalogEntryInstalled(m, opts.present, opts.mfluxCached))
    .map((m) => m.id)
  const locals = opts.locals.filter((lm) => opts.present(lm.primary)).map((lm) => lm.id)
  return [...locals, ...downloadedIds, ...catalog]
}

/** The primary filename for a catalog entry: the file tagged role 'primary', else
 *  the first file. undefined when the entry has no files. */
export function primaryFileName(entry: Pick<CatalogEntry, 'files'>): string | undefined {
  return (entry.files.find((f) => f.role === 'primary') ?? entry.files[0])?.name
}

/** The vision-projector (mmproj) filename for an entry, if it ships one. */
export function projectorFileName(entry: Pick<CatalogEntry, 'files'>): string | undefined {
  return entry.files.find((f) => f.role === 'mmproj')?.name
}

export interface VisionStatus {
  /** The model ships a vision projector — it CAN read images (once the projector is
   *  present). Derived from files, never a hand-typed flag. */
  supportsVision: boolean
  /** The projector file is present on disk. A vision model with this false is the
   *  "installed but can't see yet — offer to download the projector" case. */
  projectorInstalled: boolean
}

/** Per-model vision capability + readiness, derived from files (does it ship a
 *  projector?) and disk presence (is that projector downloaded?). Pure: presence comes
 *  from the injected predicate, so it unit-tests with no fs. */
export function visionStatus(
  entry: Pick<CatalogEntry, 'files'>,
  present: FilePresent
): VisionStatus {
  const projector = projectorFileName(entry)
  return { supportsVision: !!projector, projectorInstalled: !!projector && present(projector) }
}

/** The projector filename to heal a stale active-model config with, or undefined for
 *  "leave it alone". A config that already records a projector, or has none in its
 *  catalog entry, or whose projector isn't on disk yet, is left untouched — only the
 *  stale case (null projector + a catalog projector now present) returns a name to
 *  write. Pure decision behind reconcileActiveModelProjector. */
export function projectorToHeal(
  cfg: { id?: string; mmproj?: string | null } | null,
  entry: Pick<CatalogEntry, 'files'> | undefined,
  present: FilePresent
): string | undefined {
  if (!cfg?.id || cfg.mmproj) {
    return undefined
  }
  const projector = entry ? projectorFileName(entry) : undefined
  return projector && present(projector) ? projector : undefined
}

/** Build the per-installed-model disk entry (id, name, kind, bytes, active) for one
 *  id, resolving the source (imported local / free-form HF download / catalog) the
 *  same way getStorageInfo does. Pure: sizes come from the injected `sizeOf`.
 *
 *  `catalogById` looks up a catalog entry (undefined when the id is not a catalog
 *  model - which is how a free-form download is distinguished). */
export function buildDiskEntry(opts: {
  id: string
  locals: LocalModelLike[]
  downloaded: DownloadedModelLike[]
  catalogById: (id: string) => CatalogEntry | undefined
  isCatalogId: (id: string) => boolean
  activeChatId: string | null
  modals: Record<Modality, string | null>
  sizeOf: SizeOf
}): { id: string; name: string; kind?: string; bytes: number; active: boolean } {
  const { id, sizeOf } = opts
  const lm = id.startsWith('local:') ? opts.locals.find((m) => m.id === id) : undefined
  if (lm) {
    const bytes = [lm.primary, lm.mmproj]
      .filter(Boolean)
      .reduce((s, n) => s + sizeOf(n as string), 0)
    return {
      id,
      name: lm.name,
      kind: 'local',
      bytes,
      active: isModelActive({
        kind: 'local',
        id,
        activeChatId: opts.activeChatId,
        modals: opts.modals
      })
    }
  }
  const dl = opts.downloaded.find((m) => m.id === id)
  if (dl && !opts.isCatalogId(id)) {
    const bytes = dl.files.reduce((s, n) => s + sizeOf(n), 0)
    const primary = dl.files.find((name) => !isProjectorFileName(name)) ?? dl.files[0]
    return {
      id,
      name: dl.name,
      kind: dl.kind,
      bytes,
      active: isModelActive({
        kind: dl.kind,
        id,
        primaryFile: primary,
        activeChatId: opts.activeChatId,
        modals: opts.modals
      })
    }
  }
  const e = opts.catalogById(id)
  const bytes = (e?.files ?? []).reduce((s, f) => s + sizeOf(f.name), 0)
  const primary = e ? primaryFileName(e) : undefined
  return {
    id,
    name: e?.name ?? id,
    kind: e?.kind,
    bytes,
    active: isModelActive({
      kind: e?.kind,
      id,
      primaryFile: primary,
      activeChatId: opts.activeChatId,
      modals: opts.modals
    })
  }
}

/** Every filename the app must PROTECT from orphan cleanup: catalog files, imported
 *  local files (primary + mmproj), free-form HF download files, and the active
 *  chat selection's files. `.part` suffixes are stripped when matched, so pass the
 *  bare names. */
export function protectedNames(opts: {
  catalog: CatalogEntry[]
  localNames: Iterable<string>
  downloadedNames: Iterable<string>
  activePrimary?: string | null
  activeMmproj?: string | null
}): Set<string> {
  const known = new Set<string>()
  opts.catalog.forEach((m) => m.files.forEach((f) => known.add(f.name)))
  for (const n of opts.localNames) known.add(n)
  for (const n of opts.downloadedNames) known.add(n)
  if (opts.activePrimary) known.add(opts.activePrimary)
  if (opts.activeMmproj) known.add(opts.activeMmproj)
  return known
}

/** Split the model-dir listing into (totalBytes, orphans). A file counts when it's
 *  a .gguf or .part regular file; it's an orphan when its bare name (`.part`
 *  stripped) isn't in `known`. Pure: file stats come from `statFile`. */
export function scanModelDir(opts: {
  entries: string[]
  known: Set<string>
  statFile: (name: string) => { isFile: boolean; size: number } | null
}): { totalBytes: number; orphans: { name: string; bytes: number }[] } {
  let totalBytes = 0
  const orphans: { name: string; bytes: number }[] = []
  for (const name of opts.entries) {
    if (!name.endsWith('.gguf') && !name.endsWith('.part')) continue
    const st = opts.statFile(name)
    if (!st || !st.isFile) continue
    totalBytes += st.size
    if (!opts.known.has(name.replace(/\.part$/, ''))) orphans.push({ name, bytes: st.size })
  }
  return { totalBytes, orphans }
}

/** Resolve the modality a model id activates through, given only its kind. This is
 *  the single dispatch used by activateModel: image/voice/transcription route to a
 *  modality; text/vision/local route to the chat LLM (null). Delegates to the one
 *  source of truth in active-models. */
export function modalityForModel(kind?: string | null): Modality | null {
  return modalityForKind(kind)
}

/** Whether a kind is a per-modality pick (image/speech/transcription) as opposed to
 *  the chat LLM. Mirrors the guard in setActiveModalChoice. */
export function isModalKind(kind: string): kind is Modality {
  return kind === 'image' || kind === 'speech' || kind === 'transcription'
}

/** Whether a stored per-modality selection (`chosen`) refers to the model being
 *  deleted. A selection is stored as the catalog id for most kinds but as the
 *  PRIMARY FILENAME for image — so deleteModel must match BOTH, or deleting the
 *  active image model leaves a dangling pointer to gone files (D6). */
export function modalSelectionMatches(
  chosen: string | null | undefined,
  modelId: string,
  primaryFile?: string | null
): boolean {
  return chosen != null && (chosen === modelId || (!!primaryFile && chosen === primaryFile))
}

/** Whether a catalog entry is loadable as the chat LLM (text or vision). */
export function isChatLoadable(kind: string): boolean {
  return kind === 'text' || kind === 'vision'
}
