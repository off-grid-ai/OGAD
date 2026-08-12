// Central model management — the single source of truth for catalog, install
// listing, download (pull), delete, and activation. Used by BOTH the desktop IPC
// handlers (UI) AND the headless gateway HTTP admin endpoints, so the full
// repertoire (pull / delete / activate / list) works with or without a UI.
import fs from 'fs'
import path from 'path'
import { llm } from './llm'
import { isValidGgufFile } from './models/gguf'
import { pumpToFile } from './models/download-pump'
import { downloadIntegrityError, sha256IntegrityError } from './models/download-verify'
import { downloadFailureMessage, isStorageCapacityError } from './models/download-error'
import {
  DOWNLOAD_INTERRUPTED_ERROR,
  modelDownloadQueue,
  shutdownModelDownloads
} from './models/download-queue'
import { getAllActiveModals, setActiveModal as setModal, type Modality } from './active-models'
import {
  recordDownloaded,
  removeDownloaded,
  findDownloaded,
  installedDownloadedIds,
  downloadedProtectedNames,
  readDownloaded
} from './downloaded-models'
import {
  mergeCatalog,
  installedIds,
  buildDiskEntry,
  primaryFileName,
  protectedNames,
  scanModelDir,
  modalityForModel,
  modalSelectionMatches,
  isChatLoadable,
  visionStatus,
  projectorToHeal,
  type CatalogEntry,
  type VisionStatus
} from './models/catalog-logic'
import { writeDiagnosticLog } from './diagnostics-log'

export interface DownloadProgress {
  modelId: string
  percent?: number
  status?: 'queued' | 'downloading' | 'completed' | 'failed' | 'cancelled'
  currentFile?: string
  /** Which file of the job is in flight, 1-based, and how many the job has. percent/downloadedMB
   *  measure the WHOLE job, so these exist to say what the named file is a part of. */
  fileIndex?: number
  fileCount?: number
  downloadedMB?: string
  totalMB?: string
  error?: string
}
export type ProgressCb = (p: DownloadProgress) => void

const downloadQueue = modelDownloadQueue
const lastProgress = new Map<string, DownloadProgress>()

export { DOWNLOAD_INTERRUPTED_ERROR, shutdownModelDownloads }

function activeModelFile(): string {
  return path.join(llm.getModelsDir(), 'active-model.json')
}

/** Size (bytes) of a file in the models dir; 0 when absent/unreadable. The single
 *  FS probe injected into the pure catalog logic. */
function fileSizeOf(dir: string, name: string): number {
  try {
    return fs.statSync(path.join(dir, name)).size
  } catch {
    return 0
  }
}

export async function getCatalog(): Promise<{ kinds: readonly string[]; models: unknown[] }> {
  const { CATALOG, MODEL_KINDS } = await import('@offgrid/models')
  const dir = llm.getModelsDir()
  // Merge the three model sources (imported locals, tagged "Imported"; free-form
  // HF downloads whose files are all present, tagged "Downloaded"; then the
  // catalog) in that exact order - decision in catalog-logic, filesystem probe
  // injected as a closure so it stays pure.
  const present = (name: string): boolean => fileSizeOf(dir, name) > 0
  const models = mergeCatalog({
    locals: getLocalModels(),
    downloaded: readDownloaded(dir),
    installedDownloadedIds: installedDownloadedIds(dir),
    catalog: CATALOG as unknown as CatalogEntry[],
    present
  })
  return { kinds: MODEL_KINDS, models }
}

/** Per-model vision status for every vision-CAPABLE model, keyed by id. supportsVision
 *  is derived from files (a projector), projectorInstalled from disk. The renderer uses
 *  this to offer "download vision support" for an installed vision model whose projector
 *  isn't present yet (the Gemma 4 E2B case, where the entry gained a projector after the
 *  user had already downloaded the weights). */
export async function getVisionStatuses(): Promise<Record<string, VisionStatus>> {
  const { CATALOG } = await import('@offgrid/models')
  const dir = llm.getModelsDir()
  const present = (name: string): boolean => fileSizeOf(dir, name) > 0
  const merged = mergeCatalog({
    locals: getLocalModels(),
    downloaded: readDownloaded(dir),
    installedDownloadedIds: installedDownloadedIds(dir),
    catalog: CATALOG as unknown as CatalogEntry[],
    present
  }) as CatalogEntry[]
  const out: Record<string, VisionStatus> = {}
  for (const m of merged) {
    const st = visionStatus(m, present)
    if (st.supportsVision) {
      out[m.id] = st
    }
  }
  return out
}

/** Catalog ids (plus imported local ids) whose files are fully present on disk. */
export async function listInstalled(): Promise<string[]> {
  const { CATALOG } = await import('@offgrid/models')
  const { isMfluxModelCached } = await import('./mflux')
  const dir = llm.getModelsDir()
  return installedIds({
    locals: getLocalModels(),
    installedDownloadedIds: installedDownloadedIds(dir),
    catalog: CATALOG as unknown as CatalogEntry[],
    present: (name) => fileSizeOf(dir, name) > 0,
    mfluxCached: (id) => isMfluxModelCached(id)
  })
}

export async function searchModels(query: string, kind?: string): Promise<unknown[]> {
  try {
    const { searchHuggingFace } = await import('@offgrid/models')
    return await searchHuggingFace(query, { limit: 30, kind: kind as never })
  } catch (err) {
    console.error('[models] HF search failed:', err)
    return []
  }
}

export function downloadStatus(modelId: string): DownloadProgress | null {
  return lastProgress.get(modelId) ?? null
}

export function cancelDownload(modelId: string): boolean {
  const cancelled = downloadQueue.cancel(modelId)
  writeDiagnosticLog('models.download', 'cancel.requested', { modelId, cancelled })
  return cancelled
}

/** A download refused before it ever reached the queue is still an OUTCOME the watchers must see.
 *  The refusal used to be returned to the caller only, so the status registry kept whatever the UI
 *  had assumed and the card sat on a spinner forever. Publishing 'failed' the same way a mid-transfer
 *  failure does means every client — the screen, a headless poller, the registry — learns the same
 *  thing from one place, whether the download died at byte zero or at the last one. */
function publishRefusal(
  modelId: string,
  error: string,
  onProgress?: ProgressCb
): { success: false; error: string } {
  const p: DownloadProgress = { modelId, status: 'failed', percent: 0, error }
  lastProgress.set(modelId, p)
  onProgress?.(p)
  return { success: false, error }
}

/** Download a catalog entry or any Hugging Face repo id. Progress via callback
 *  AND a status registry (so a headless poller can read it). */
export async function downloadModel(
  modelId: string,
  onProgress?: ProgressCb
): Promise<{ success: boolean; error?: string }> {
  if (!downloadQueue.isAccepting()) {
    writeDiagnosticLog('models.download', 'request.rejected', {
      modelId,
      reason: 'application_shutdown'
    })
    return publishRefusal(modelId, DOWNLOAD_INTERRUPTED_ERROR, onProgress)
  }
  const { CATALOG, resolveHuggingFaceModel } = await import('@offgrid/models')
  const inCatalog = CATALOG.find((m) => m.id === modelId)
  const entry = inCatalog ?? (await resolveHuggingFaceModel(modelId))
  if (!entry) {
    writeDiagnosticLog('models.download', 'request.rejected', { modelId, reason: 'unknown_model' })
    return publishRefusal(modelId, 'unknown model', onProgress)
  }
  writeDiagnosticLog('models.download', 'request.accepted', {
    modelId,
    kind: entry.kind,
    files: entry.files.length
  })

  const dir = llm.getModelsDir()
  fs.mkdirSync(dir, { recursive: true })
  ensureRegistryLoaded()
  // Re-entrancy guard (before any status emit / queue registration): a second
  // download of the same id would write into the SAME .part (interleaved writes →
  // corrupt file). The queue tracks both waiting and active ids, so double-clicking
  // a queued card cannot enqueue it twice either.
  if (downloadQueue.has(modelId)) {
    writeDiagnosticLog('models.download', 'request.rejected', {
      modelId,
      reason: 'already_downloading'
    })
    return { success: false, error: 'already downloading' }
  }
  let loggedStatus: DownloadProgress['status'] | undefined
  const send = (data: Partial<DownloadProgress>): void => {
    const p: DownloadProgress = { modelId, ...data }
    lastProgress.set(modelId, p)
    onProgress?.(p)
    if (p.status && p.status !== loggedStatus) {
      loggedStatus = p.status
      writeDiagnosticLog(
        'models.download',
        `status.${p.status}`,
        { modelId, error: p.error, percent: p.percent },
        p.status === 'failed' ? 'error' : 'info'
      )
    }
    // Queue/start persistence happens in the lifecycle callback below. Persist
    // terminal transitions here, but skip high-frequency transfer ticks.
    if (p.status && p.status !== 'queued' && p.status !== 'downloading') persistRegistry()
  }
  const interruptedResult = (
    signal: AbortSignal,
    activePartPath: string | null
  ): { success: false; error: string } => {
    const interrupted = signal.reason === DOWNLOAD_INTERRUPTED_ERROR
    if (!interrupted && activePartPath) fs.rmSync(activePartPath, { force: true })
    const error = interrupted ? DOWNLOAD_INTERRUPTED_ERROR : 'cancelled'
    send(interrupted ? { status: 'failed', error } : { status: 'cancelled' })
    return { success: false, error }
  }
  return downloadQueue.enqueue(
    modelId,
    async (signal) => {
      if (entry.runtime === 'mflux') {
        try {
          const { downloadMfluxModel } = await import('./mflux')
          await downloadMfluxModel(modelId, (pct: number) =>
            send({ percent: pct, status: 'downloading' })
          )
          send({ percent: 100, status: 'completed' })
          return { success: true }
        } catch (err) {
          const error = downloadFailureMessage(err)
          send({ status: 'failed', error })
          return { success: false, error }
        }
      }

      let activePartPath: string | null = null
      try {
        // Decide the JOB before reporting on it. A model is several files, and percent used to be
        // per-file: a two-file download ran 0→100 for the weights and then 0→100 again for the
        // projector, so the number reset halfway and meant something different each time. The job
        // is the set of files this run must actually fetch (a file already on disk is not work),
        // and one percent measures the whole of it.
        const pending = entry.files.filter((file) => {
          const dest = path.join(dir, file.name)
          const present = fs.existsSync(dest) && fs.statSync(dest).size > 0
          if (present) {
            writeDiagnosticLog('models.download', 'file.skipped', {
              modelId,
              file: file.name,
              reason: 'already_present'
            })
          }
          return !present
        })
        // Catalog sizes plan the denominator; the file being fetched contributes its REAL
        // content-length instead, so the total sharpens as the job proceeds rather than drifting.
        const plannedBytes = pending.map((file) => file.sizeBytes ?? 0)
        const laterBytes = (index: number): number =>
          plannedBytes.slice(index + 1).reduce((sum, bytes) => sum + bytes, 0)
        let jobDoneBytes = 0
        for (const [fileIndex, file] of pending.entries()) {
          const dest = path.join(dir, file.name)
          const partPath = `${dest}.part`
          activePartPath = partPath
          // Resume from a partial .part if one exists (e.g. download interrupted by a
          // quit/crash) via an HTTP Range request, so we don't re-fetch GBs.
          let resumeFrom = 0
          try {
            if (fs.existsSync(partPath)) resumeFrom = fs.statSync(partPath).size
          } catch {
            /* fresh */
          }
          writeDiagnosticLog('models.download', 'file.started', {
            modelId,
            file: file.name,
            resumeBytes: resumeFrom
          })
          const res = await fetch(file.url, {
            signal,
            headers: resumeFrom > 0 ? { Range: `bytes=${resumeFrom}-` } : undefined
          })
          if (!res.ok || !res.body) throw new Error(`HTTP ${res.status} for ${file.name}`)
          // Server honored the range (206) → append; otherwise (200) start over.
          const append = resumeFrom > 0 && res.status === 206
          const remaining = Number(res.headers.get('content-length') ?? 0)
          const total = (append ? resumeFrom : 0) + remaining
          const out = fs.createWriteStream(partPath, append ? { flags: 'a' } : {})
          let written = append ? resumeFrom : 0
          const reader = res.body.getReader()
          // pumpToFile owns the write-stream error path: a disk-full/EIO 'error' becomes
          // a rejection (caught below → status 'failed') instead of crashing the main
          // process, and never hangs on a 'finish' that won't come.
          await pumpToFile(reader, out, (n) => {
            written += n
            const jobDone = jobDoneBytes + written
            const jobTotal = jobDoneBytes + total + laterBytes(fileIndex)
            send({
              currentFile: file.name,
              fileIndex: fileIndex + 1,
              fileCount: pending.length,
              percent: jobTotal ? Math.round((jobDone / jobTotal) * 100) : 0,
              downloadedMB: (jobDone / 1048576).toFixed(1),
              totalMB: jobTotal ? (jobTotal / 1048576).toFixed(1) : '?',
              status: 'downloading'
            })
          })
          if (signal.aborted) {
            return interruptedResult(signal, partPath)
          }
          // Verify the file is complete + valid BEFORE promoting it — never mark a
          // truncated/corrupt download installed (it loads as a blank "Chat model Down").
          const integrityErr = downloadIntegrityError(file.name, written, total, partPath)
          if (integrityErr) throw new Error(integrityErr)
          // Content check: when the file carries an expected SHA-256 (e.g. HF's lfs
          // oid), verify the bytes match — catches silent corruption the byte-count +
          // magic check can't. Skipped when no hash is known.
          const checksumErr = await sha256IntegrityError(
            file.name,
            partPath,
            (file as { sha256?: string }).sha256
          )
          if (checksumErr) throw new Error(checksumErr)
          fs.renameSync(partPath, dest)
          activePartPath = null
          jobDoneBytes += written // this file's real bytes now count toward the job, not a new 0%
          writeDiagnosticLog('models.download', 'file.completed', {
            modelId,
            file: file.name,
            bytes: written
          })
        }
        if (signal.aborted) return interruptedResult(signal, activePartPath)
        // Register a free-form Hugging Face download (not a catalog entry) so it counts
        // as installed + activatable and its files aren't flagged as "unused". Catalog
        // models are recognized by CATALOG membership already, so skip them.
        if (!inCatalog) {
          recordDownloaded(dir, {
            id: modelId,
            name: entry.name,
            kind: entry.kind,
            files: entry.files.map((f) => f.name)
          })
        }
        // If this download added the projector for the active chat model, turn its
        // vision on now (main-side, so it works even when no Models screen is open).
        await reconcileActiveModelProjector().catch(() => false)
        send({ percent: 100, status: 'completed' })
        return { success: true }
      } catch (err) {
        // A capacity failure cannot resume until space is reclaimed, and retaining the
        // bytes makes the full-volume condition worse. Other failures keep their
        // partial file so retry can resume instead of downloading it again.
        if (activePartPath && isStorageCapacityError(err)) {
          try {
            fs.rmSync(activePartPath, { force: true })
          } catch {
            /* retain the original write failure */
          }
        }
        if (signal.aborted || (err as Error).name === 'AbortError') {
          return interruptedResult(signal, activePartPath)
        }
        const error = downloadFailureMessage(err)
        send({ status: 'failed', error })
        return { success: false, error }
      }
    },
    (state) => {
      if (state === 'interrupted') {
        send({ status: 'failed', error: DOWNLOAD_INTERRUPTED_ERROR, percent: 0 })
      } else {
        send({ status: state, percent: 0 })
      }
      if (state === 'queued' || state === 'downloading') persistRegistry()
    }
  )
}

/** Delete a model's files from disk. Clears it as active if it was selected. */
export async function deleteModel(
  modelId: string
): Promise<{ success: boolean; error?: string; freedFiles?: number }> {
  const dir = llm.getModelsDir()
  // Imported local model: remove its files + registry entry, clear if active.
  if (modelId.startsWith('local:')) {
    const list = getLocalModels()
    const lm = list.find((m) => m.id === modelId)
    if (!lm) return { success: false, error: 'unknown local model' }
    let freedLocal = 0
    for (const name of [lm.primary, lm.mmproj].filter(Boolean) as string[]) {
      try {
        fs.rmSync(path.join(dir, name), { force: true })
        freedLocal++
      } catch {
        /* ignore */
      }
    }
    saveLocalModels(list.filter((m) => m.id !== modelId))
    if (getActiveModel() === modelId) {
      try {
        fs.rmSync(activeModelFile(), { force: true })
      } catch {
        /* ignore */
      }
      llm.reloadModel()
    }
    return { success: true, freedFiles: freedLocal }
  }
  const { CATALOG, resolveHuggingFaceModel } = await import('@offgrid/models')
  const entry = CATALOG.find((m) => m.id === modelId) ?? (await resolveHuggingFaceModel(modelId))
  if (!entry) return { success: false, error: 'unknown model' }
  let freed = 0

  if (entry.runtime === 'mflux') {
    try {
      const mod = await import('./mflux')
      const del = (mod as Record<string, unknown>).deleteMfluxModel
      if (typeof del === 'function') await (del as (id: string) => Promise<void>)(modelId)
    } catch (e) {
      console.warn('[models] mflux delete', e)
    }
  } else {
    for (const f of entry.files) {
      try {
        fs.rmSync(path.join(dir, f.name), { force: true })
        freed++
      } catch {
        /* ignore */
      }
      try {
        fs.rmSync(path.join(dir, `${f.name}.part`), { force: true })
      } catch {
        /* ignore */
      }
    }
    // Drop it from the downloaded registry too (no-op for a catalog model).
    if (findDownloaded(dir, modelId)) removeDownloaded(dir, modelId)
  }

  // If this was the active chat model, clear the selection so we don't point at gone files.
  if (getActiveModel() === modelId) {
    try {
      fs.rmSync(activeModelFile(), { force: true })
    } catch {
      /* ignore */
    }
    llm.reloadModel()
  }
  // Clear any per-modality selection pointing at it — matching the id AND the
  // primary filename, because image picks are stored by filename (D6: without the
  // filename match, deleting the active image model left a dangling pointer).
  const primaryFile =
    entry.runtime === 'mflux' ? null : primaryFileName(entry as unknown as CatalogEntry)
  const modals = getAllActiveModals()
  ;(Object.keys(modals) as Modality[]).forEach((k) => {
    if (modalSelectionMatches(modals[k], modelId, primaryFile)) setModal(k, null)
  })
  return { success: true, freedFiles: freed }
}

/** Set the chat LLM (text/vision). Writes active-model.json + reloads llama-server. */
export async function setActiveModel(
  modelId: string
): Promise<{ success: boolean; error?: string }> {
  // Imported local model: resolve from the local registry (not the catalog).
  if (modelId.startsWith('local:')) {
    const lm = getLocalModels().find((m) => m.id === modelId)
    if (!lm) return { success: false, error: 'unknown local model' }
    fs.writeFileSync(
      activeModelFile(),
      JSON.stringify({ id: modelId, primary: lm.primary, mmproj: lm.mmproj ?? null }, null, 2)
    )
    llm.reloadModel()
    return { success: true }
  }
  const { CATALOG, resolveHuggingFaceModel } = await import('@offgrid/models')
  const entry = CATALOG.find((m) => m.id === modelId) ?? (await resolveHuggingFaceModel(modelId))
  if (!entry) return { success: false, error: 'unknown model' }
  if (!isChatLoadable(entry.kind)) {
    return { success: false, error: `${entry.kind} models are not loadable as the chat LLM` }
  }
  const primary = primaryFileName(entry as unknown as CatalogEntry)
  const mmproj = entry.files.find((f) => f.role === 'mmproj')?.name ?? null
  fs.writeFileSync(activeModelFile(), JSON.stringify({ id: modelId, primary, mmproj }, null, 2))
  llm.reloadModel()
  return { success: true }
}

export function getActiveModel(): string | null {
  try {
    return JSON.parse(fs.readFileSync(activeModelFile(), 'utf-8')).id ?? null
  } catch {
    return null
  }
}

/** Heal a stale active-model.json that predates its model gaining a vision projector.
 *  A model activated BEFORE its catalog entry had an mmproj (e.g. Gemma 4 E2B) stored
 *  `mmproj: null`; once the projector is downloaded, hasVision() still reads that null
 *  and the model stays text-only forever. This re-derives the projector from the
 *  catalog and, if the file is now present on disk, writes it into active-model.json and
 *  reloads — so vision turns on without a manual re-activate. Runs at startup and after
 *  every download completes, independent of which screen (if any) is open. Returns true
 *  when it healed something. */
export async function reconcileActiveModelProjector(): Promise<boolean> {
  let cfg: { id?: string; primary?: string; mmproj?: string | null } | null = null
  try {
    cfg = JSON.parse(fs.readFileSync(activeModelFile(), 'utf-8'))
  } catch {
    return false // no active selection yet
  }
  const { CATALOG } = await import('@offgrid/models')
  const dir = llm.getModelsDir()
  const entry = (CATALOG as unknown as CatalogEntry[]).find((m) => m.id === cfg!.id)
  const projector = projectorToHeal(cfg, entry, (name) => fileSizeOf(dir, name) > 0)
  if (!projector) {
    return false // already has one / no projector / not downloaded yet — leave as is
  }
  fs.writeFileSync(activeModelFile(), JSON.stringify({ ...cfg, mmproj: projector }, null, 2))
  llm.reloadModel()
  return true
}

/**
 * The active model id for EVERY modality (chat LLM + image/voice/transcription),
 * as catalog/local ids. The single "what's active" truth the UI consults so it
 * can mark any model active without re-deriving per-kind rules. Reuses the
 * per-entry active computation in getStorageInfo (one definition of "active").
 */
export async function getActiveModelIds(): Promise<string[]> {
  const info = await getStorageInfo()
  return info.models.filter((m) => m.active).map((m) => m.id)
}

/**
 * Make ANY installed model the active one for its type — the single seam the UI
 * calls. Routes by kind internally: text/vision load the chat LLM; image/voice/
 * transcription set that modality's default pick. Callers pass only the id and
 * never branch on kind. Adding a new modality needs zero caller changes.
 */
export async function activateModel(
  modelId: string
): Promise<{ success: boolean; error?: string }> {
  let kind: string | undefined
  if (modelId.startsWith('local:')) {
    kind = getLocalModels().find((m) => m.id === modelId)?.kind
  } else {
    const { CATALOG, resolveHuggingFaceModel } = await import('@offgrid/models')
    kind = (CATALOG.find((m) => m.id === modelId) ?? (await resolveHuggingFaceModel(modelId)))?.kind
  }
  const modal = modalityForModel(kind)
  return modal ? setActiveModalChoice(modal, modelId) : setActiveModel(modelId)
}

export async function setActiveModalChoice(
  kind: string,
  modelId: string | null
): Promise<{ success: boolean; error?: string }> {
  // Normalize to the storage modality so BOTH vocabularies work — the setup path
  // passes 'voice', the UI/dispatch pass 'speech'. Before this, the guard only
  // accepted 'speech', so "Configure for me" (which passes 'voice') silently failed
  // to activate TTS (D26). One normalizer is the single source of truth.
  const modal = modalityForModel(kind)
  if (modal) {
    let stored = modelId
    // The image resolver loads by FILENAME, but the UI passes a catalog id — map it
    // to the entry's primary filename so an in-app pick (e.g. Juggernaut) takes effect.
    if (modelId && modal === 'image') {
      try {
        const { CATALOG } = await import('@offgrid/models')
        const e = CATALOG.find((m) => m.id === modelId)
        const fname = e ? primaryFileName(e as unknown as CatalogEntry) : undefined
        if (fname) stored = fname
      } catch {
        /* keep modelId as-is */
      }
    }
    setModal(modal, stored)
    return { success: true }
  }
  return { success: false, error: 'use setActiveModel for the chat LLM (text/vision)' }
}

export function getActiveModalities(): { text: string | null } & Record<Modality, string | null> {
  return { text: getActiveModel(), ...getAllActiveModals() }
}

// ---------------------------------------------------------------------------
// Local model import: a registry of user-imported .gguf files (not in the
// catalog), wired through list/activate/delete/storage so they behave like any
// other installed model — and are protected from orphan cleanup.
// ---------------------------------------------------------------------------

export interface LocalModel {
  id: string
  name: string
  primary: string
  mmproj?: string
  kind: 'text' | 'vision'
  params?: number
  sizeBytes: number
}

export type TransferableModelSource = 'catalog' | 'downloaded' | 'local'

export interface TransferableModelFile {
  name: string
  sizeBytes: number
  path: string
}

export interface TransferableModel {
  id: string
  name: string
  kind: string
  source: TransferableModelSource
  files: TransferableModelFile[]
}

export interface TransferredModelManifest {
  id: string
  name: string
  kind: string
  source: TransferableModelSource
  files: Array<{ name: string; sizeBytes: number }>
}

function localRegistryFile(dir = llm.getModelsDir()): string {
  return path.join(dir, 'local-models.json')
}

export function getLocalModels(dir = llm.getModelsDir()): LocalModel[] {
  try {
    const arr = JSON.parse(fs.readFileSync(localRegistryFile(dir), 'utf-8'))
    return Array.isArray(arr) ? (arr as LocalModel[]) : []
  } catch {
    return []
  }
}
function saveLocalModels(list: LocalModel[], dir = llm.getModelsDir()): void {
  try {
    fs.writeFileSync(localRegistryFile(dir), JSON.stringify(list, null, 2))
  } catch {
    /* best effort */
  }
}

function safeTransferredFileName(name: string): boolean {
  return (
    name.length > 0 &&
    name.length <= 255 &&
    path.basename(name) === name &&
    name !== '.' &&
    name !== '..'
  )
}

function transferredFilesOnDisk(
  dir: string,
  files: Array<{ name: string; sizeBytes: number }>
): { error?: string; files?: TransferableModelFile[] } {
  if (files.length === 0) return { error: 'model has no transferable files' }
  const names = new Set<string>()
  const resolved: TransferableModelFile[] = []
  for (const file of files) {
    if (
      !safeTransferredFileName(file.name) ||
      !Number.isSafeInteger(file.sizeBytes) ||
      file.sizeBytes <= 0 ||
      names.has(file.name)
    ) {
      return { error: 'model manifest contains an invalid file' }
    }
    names.add(file.name)
    const filePath = path.join(dir, file.name)
    let actualSize = 0
    try {
      const stat = fs.lstatSync(filePath)
      if (!stat.isFile() || stat.isSymbolicLink()) {
        return { error: `${file.name}: transferred file is not a regular file` }
      }
      actualSize = stat.size
    } catch {
      return { error: `${file.name}: transferred file is missing` }
    }
    if (actualSize !== file.sizeBytes) {
      return { error: `${file.name}: transferred file size does not match the manifest` }
    }
    if (/\.gguf$/i.test(file.name) && !isValidGgufFile(filePath, fs)) {
      return { error: `${file.name}: transferred file is not a valid GGUF model` }
    }
    resolved.push({ ...file, path: filePath })
  }
  return { files: resolved }
}

/**
 * Resolve one installed, file-backed model for device transfer. Runtime caches such as mflux are
 * intentionally excluded because they are directory trees, not portable model files.
 */
export async function getTransferableModel(
  modelId: string,
  dir = llm.getModelsDir()
): Promise<TransferableModel | null> {
  const local = getLocalModels(dir).find((model) => model.id === modelId)
  const downloaded = findDownloaded(dir, modelId)
  const { CATALOG } = await import('@offgrid/models')
  const catalog = CATALOG.find((model) => model.id === modelId)

  const source: TransferableModelSource | null = local
    ? 'local'
    : downloaded
      ? 'downloaded'
      : catalog && catalog.runtime !== 'mflux'
        ? 'catalog'
        : null
  if (!source) return null

  const names = local
    ? [local.primary, local.mmproj].filter((name): name is string => Boolean(name))
    : downloaded
      ? downloaded.files
      : (catalog?.files.map((file) => file.name) ?? [])
  const files = transferredFilesOnDisk(
    dir,
    names.map((name) => ({ name, sizeBytes: fileSizeOf(dir, name) }))
  ).files
  if (!files) return null

  return {
    id: modelId,
    name: local?.name ?? downloaded?.name ?? catalog?.name ?? modelId,
    kind: local?.kind ?? downloaded?.kind ?? catalog?.kind ?? 'text',
    source,
    files
  }
}

/**
 * Register model files only after the transfer owner has checksum-verified and atomically promoted
 * every file into the models directory. The catalog remains the source of truth for known models;
 * free-form and local models are recorded in their existing registries.
 */
export async function registerTransferredModel(
  manifest: TransferredModelManifest,
  dir = llm.getModelsDir()
): Promise<{ success: boolean; error?: string; id?: string }> {
  if (
    !manifest.id ||
    manifest.id.length > 512 ||
    !manifest.name ||
    manifest.name.length > 512 ||
    !manifest.kind ||
    manifest.kind.length > 128
  ) {
    return { success: false, error: 'model manifest is invalid' }
  }

  const resolved = transferredFilesOnDisk(dir, manifest.files)
  if (!resolved.files) return { success: false, error: resolved.error }

  const { CATALOG } = await import('@offgrid/models')
  const catalog = CATALOG.find((model) => model.id === manifest.id)
  if (catalog) {
    const expected = new Set(catalog.files.map((file) => file.name))
    const received = new Set(manifest.files.map((file) => file.name))
    if (expected.size !== received.size || [...expected].some((name) => !received.has(name))) {
      return { success: false, error: 'transferred catalog model files do not match the catalog' }
    }
    return { success: true, id: manifest.id }
  }

  if (manifest.source === 'local') {
    const primary =
      manifest.files.find(
        (file) => /\.gguf$/i.test(file.name) && !/mmproj|projector/i.test(file.name)
      ) ?? manifest.files.find((file) => /\.gguf$/i.test(file.name))
    if (!primary) return { success: false, error: 'local model transfer requires a GGUF file' }
    const mmproj = manifest.files.find(
      (file) => file.name !== primary.name && /\.gguf$/i.test(file.name)
    )
    const id = `local:${primary.name}`
    const list = getLocalModels(dir).filter((model) => model.id !== id)
    list.push({
      id,
      name: manifest.name,
      primary: primary.name,
      mmproj: mmproj?.name,
      kind: mmproj ? 'vision' : 'text',
      sizeBytes: primary.sizeBytes
    })
    saveLocalModels(list, dir)
    if (!getLocalModels(dir).some((model) => model.id === id)) {
      return { success: false, error: 'could not register the transferred local model' }
    }
    return { success: true, id }
  }

  recordDownloaded(dir, {
    id: manifest.id,
    name: manifest.name,
    kind: manifest.kind,
    files: manifest.files.map((file) => file.name)
  })
  if (!findDownloaded(dir, manifest.id)) {
    return { success: false, error: 'could not register the transferred model' }
  }
  if (dir === llm.getModelsDir()) {
    await reconcileActiveModelProjector().catch(() => false)
  }
  return { success: true, id: manifest.id }
}

/** Set of every filename referenced by the local registry (primary + mmproj), so
 *  storage/orphan logic never deletes an imported model. */
function localProtectedNames(): Set<string> {
  const s = new Set<string>()
  for (const m of getLocalModels()) {
    s.add(m.primary)
    if (m.mmproj) s.add(m.mmproj)
  }
  return s
}

/** A real GGUF starts with the "GGUF" magic and is more than a few bytes. */
/** Import a local .gguf: validate, stream-copy into the models dir (with progress),
 *  and register it so it shows up as an installed, activatable model. */
export async function importLocalModel(
  srcPath: string,
  onProgress?: ProgressCb
): Promise<{ success: boolean; error?: string; id?: string }> {
  if (!srcPath || !srcPath.toLowerCase().endsWith('.gguf'))
    return { success: false, error: 'Not a .gguf file' }
  if (!isValidGgufFile(srcPath, fs))
    return { success: false, error: 'File is not a valid GGUF model (corrupt or wrong format)' }

  const dir = llm.getModelsDir()
  fs.mkdirSync(dir, { recursive: true })
  const fileName = path.basename(srcPath)
  const dest = path.join(dir, fileName)
  const id = `local:${fileName}`
  const total = fs.statSync(srcPath).size
  const send = (data: Partial<DownloadProgress>): void => {
    onProgress?.({ modelId: id, ...data })
  }

  // Copy unless an identical-size file is already there.
  const already = fs.existsSync(dest) && fs.statSync(dest).size === total
  if (!already) {
    try {
      await new Promise<void>((resolve, reject) => {
        const rd = fs.createReadStream(srcPath)
        const wr = fs.createWriteStream(dest)
        let copied = 0
        rd.on('data', (c) => {
          copied += c.length
          send({
            status: 'downloading',
            percent: total ? Math.round((copied / total) * 100) : 0,
            currentFile: fileName
          })
        })
        rd.on('error', reject)
        wr.on('error', reject)
        wr.on('finish', () => resolve())
        rd.pipe(wr)
      })
    } catch (e) {
      try {
        fs.rmSync(dest, { force: true })
      } catch {
        /* ignore */
      }
      send({ status: 'failed', error: (e as Error).message })
      return { success: false, error: (e as Error).message }
    }
  }

  // Heuristic kind: a paired mmproj makes it vision; otherwise treat as text.
  const base = fileName.replace(/\.gguf$/i, '')
  const list = getLocalModels().filter((m) => m.id !== id)
  list.push({ id, name: base, primary: fileName, kind: 'text', sizeBytes: total })
  saveLocalModels(list)
  send({ status: 'completed', percent: 100 })
  return { success: true, id }
}

// ---------------------------------------------------------------------------
// Storage: disk usage, free space, orphan cleanup
// ---------------------------------------------------------------------------

export interface ModelDiskEntry {
  id: string
  name: string
  kind?: string
  bytes: number
  active: boolean
}
export interface StorageInfo {
  dir: string
  totalBytes: number // all model files (incl. orphans + .part) in the models dir
  freeBytes: number // free space on the volume
  models: ModelDiskEntry[]
  orphans: { name: string; bytes: number }[]
}

/** Disk usage for models: per installed model, total, free space, and orphan files
 *  (gguf/.part in the models dir that no catalog entry or active selection claims). */
export async function getStorageInfo(): Promise<StorageInfo> {
  const dir = llm.getModelsDir()
  const { CATALOG } = await import('@offgrid/models')
  const catalog = CATALOG as unknown as CatalogEntry[]
  // Protect catalog + imported-local + free-form-download files, plus the active
  // chat selection's files, from being flagged/deleted as orphans.
  let activePrimary: string | null = null
  let activeMmproj: string | null = null
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(dir, 'active-model.json'), 'utf-8'))
    activePrimary = cfg?.primary ?? null
    activeMmproj = cfg?.mmproj ?? null
  } catch {
    /* none */
  }
  const known = protectedNames({
    catalog,
    localNames: localProtectedNames(),
    downloadedNames: downloadedProtectedNames(dir),
    activePrimary,
    activeMmproj
  })

  const active = getActiveModel()
  // Per-modality active picks (image/speech/transcription) are stored as the
  // chosen FILENAME, not the catalog id — so an image/voice/STT model is "active"
  // when its primary file matches. Without this, only the chat LLM ever shows
  // active and image models can't be activated from the UI.
  const modals = getAllActiveModals()
  const locals = getLocalModels()
  const installed = await listInstalled()
  const sizeOf = (name: string): number => fileSizeOf(dir, name)
  const downloaded = readDownloaded(dir)
  const catalogIds = new Set(catalog.map((m) => m.id))
  const catalogById = (id: string): CatalogEntry | undefined => catalog.find((m) => m.id === id)
  const models: ModelDiskEntry[] = installed.map((id) =>
    buildDiskEntry({
      id,
      locals,
      downloaded,
      catalogById,
      isCatalogId: (x) => catalogIds.has(x),
      activeChatId: active,
      modals,
      sizeOf
    })
  )

  let entries: string[] = []
  try {
    entries = fs.readdirSync(dir)
  } catch {
    /* no dir yet */
  }
  const statFile = (name: string): { isFile: boolean; size: number } | null => {
    try {
      const st = fs.statSync(path.join(dir, name))
      return { isFile: st.isFile(), size: st.size }
    } catch {
      return null
    }
  }
  const { totalBytes, orphans } = scanModelDir({ entries, known, statFile })

  let freeBytes = 0
  try {
    const s = fs.statfsSync(dir)
    freeBytes = s.bavail * s.bsize
  } catch {
    /* unknown */
  }
  return { dir, totalBytes, freeBytes, models, orphans }
}

/** Delete every orphan file (unreferenced gguf/.part). Recomputes the orphan set so
 *  it can never touch a catalog model or the active selection. */
export async function deleteOrphans(): Promise<{
  success: boolean
  count: number
  freedBytes: number
}> {
  const info = await getStorageInfo()
  const dir = llm.getModelsDir()
  let freedBytes = 0,
    count = 0
  for (const o of info.orphans) {
    try {
      fs.rmSync(path.join(dir, o.name), { force: true })
      freedBytes += o.bytes
      count++
    } catch {
      /* ignore */
    }
  }
  return { success: true, count, freedBytes }
}

// ---------------------------------------------------------------------------
// Download registry: surface active/failed/completed downloads + retry, and
// survive an app restart (an interrupted download becomes resumable).
// ---------------------------------------------------------------------------

function downloadsFile(): string {
  return path.join(llm.getModelsDir(), 'downloads.json')
}
let registryLoaded = false
function ensureRegistryLoaded(): void {
  if (registryLoaded) return
  registryLoaded = true
  try {
    const arr = JSON.parse(fs.readFileSync(downloadsFile(), 'utf-8')) as DownloadProgress[]
    for (const p of arr) {
      // Anything still active/queued when we last wrote was cut off by a quit/crash.
      // Surface it as explicitly retryable instead of leaving a queue row that can
      // never drain in this fresh process.
      if (p.status === 'downloading' || p.status === 'queued') {
        p.status = 'failed'
        p.error = DOWNLOAD_INTERRUPTED_ERROR
      }
      lastProgress.set(p.modelId, p)
    }
  } catch {
    /* no registry yet */
  }
}
function persistRegistry(): void {
  try {
    const arr = Array.from(lastProgress.values()).filter((p) => p.status !== 'completed')
    if (arr.length) fs.writeFileSync(downloadsFile(), JSON.stringify(arr))
    else fs.rmSync(downloadsFile(), { force: true })
  } catch {
    /* best effort */
  }
}

/** All known downloads (active, failed, interrupted) for a download-manager view. */
export function listDownloads(): DownloadProgress[] {
  ensureRegistryLoaded()
  return Array.from(lastProgress.values())
}

/** Retry (resumes from the partial .part) a failed/interrupted download. */
export async function retryDownload(
  modelId: string,
  onProgress?: ProgressCb
): Promise<{ success: boolean; error?: string }> {
  return downloadModel(modelId, onProgress)
}

/** Dismiss a download-manager entry: abort it if still running, delete its partial
 *  .part files, and drop it from the registry so it leaves the Downloads list. */
export async function clearDownload(
  modelId: string
): Promise<{ success: boolean; freedBytes: number }> {
  cancelDownload(modelId) // no-op if not currently downloading
  let freedBytes = 0
  try {
    const dir = llm.getModelsDir()
    const { CATALOG, resolveHuggingFaceModel } = await import('@offgrid/models')
    const entry =
      CATALOG.find((m) => m.id === modelId) ??
      (await resolveHuggingFaceModel(modelId).catch(() => null))
    for (const f of entry?.files ?? []) {
      const part = path.join(dir, `${f.name}.part`)
      try {
        freedBytes += fs.statSync(part).size
      } catch {
        /* none */
      }
      try {
        fs.rmSync(part, { force: true })
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* best effort */
  }
  ensureRegistryLoaded()
  lastProgress.delete(modelId)
  persistRegistry()
  return { success: true, freedBytes }
}

/** Clear every failed/cancelled/interrupted download (entry + .part). */
export async function clearInactiveDownloads(): Promise<{
  success: boolean
  count: number
  freedBytes: number
}> {
  ensureRegistryLoaded()
  const ids = Array.from(lastProgress.values())
    .filter((p) => p.status === 'failed' || p.status === 'cancelled')
    .map((p) => p.modelId)
  let freedBytes = 0
  for (const id of ids) {
    const r = await clearDownload(id)
    freedBytes += r.freedBytes
  }
  return { success: true, count: ids.length, freedBytes }
}
