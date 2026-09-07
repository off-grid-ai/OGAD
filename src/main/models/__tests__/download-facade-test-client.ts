// The download journey as a TEST CLIENT of the real Shared Models facade.
//
// Before the model-control cutover these suites called `models-manager`'s own download functions.
// That surface is gone: downloads are owned by `@offgrid/application`'s Models facade, and Desktop
// only supplies ports. This file is the thin projection those suites used to get from the manager —
// a `{ modelId, percent, status, ... }` row and a `{ success, error }` result — expressed over the
// typed facade commands. It fakes nothing: every call below is the production command the Models
// screen issues, over the production Desktop download ports.
import {
  CATALOG,
  DOWNLOAD_INTERRUPTED_ERROR,
  type PublicDownloadEvent,
  type PublicDownloadInfo
} from '@offgrid/models'
import { modelsFailureMessage, type OffGridApplication } from '@offgrid/application'

export interface DownloadProgress {
  modelId: string
  percent?: number
  status?: 'queued' | 'downloading' | 'completed' | 'failed' | 'cancelled'
  currentFile?: string
  fileIndex?: number
  fileCount?: number
  downloadedMB?: string
  totalMB?: string
  downloadedBytes?: number
  totalBytes?: number
  error?: string
}

export interface DownloadResult {
  success: boolean
  error?: string
}

function status(value: PublicDownloadInfo['status']): DownloadProgress['status'] {
  if (value === 'completed' || value === 'failed' || value === 'cancelled' || value === 'queued') {
    return value
  }
  if (value === 'interrupted') return 'failed'
  return 'downloading'
}

function reconciliationFailure(value: object): string | undefined {
  return 'reconciliationFailure' in value && typeof value.reconciliationFailure === 'string'
    ? value.reconciliationFailure
    : undefined
}

function progressFields(input: {
  modelId: string
  fileName: string
  bytesDownloaded?: number
  totalBytes?: number
}): Pick<
  DownloadProgress,
  | 'modelId'
  | 'currentFile'
  | 'fileIndex'
  | 'fileCount'
  | 'downloadedBytes'
  | 'totalBytes'
  | 'downloadedMB'
  | 'totalMB'
  | 'percent'
> {
  const catalog = CATALOG.find((entry) => entry.id === input.modelId)
  const fileIndex = catalog?.files.findIndex((file) => file.name === input.fileName) ?? -1
  const downloadedBytes = input.bytesDownloaded ?? 0
  const totalBytes = input.totalBytes ?? 0
  return {
    modelId: input.modelId,
    currentFile: input.fileName,
    fileIndex: fileIndex >= 0 ? fileIndex + 1 : undefined,
    fileCount: catalog?.files.length,
    downloadedBytes,
    totalBytes: totalBytes || undefined,
    downloadedMB: (downloadedBytes / 1_048_576).toFixed(1),
    totalMB: totalBytes ? (totalBytes / 1_048_576).toFixed(1) : '?',
    percent: totalBytes ? Math.round((downloadedBytes / totalBytes) * 100) : 0
  }
}

function projectEvent(event: PublicDownloadEvent): DownloadProgress {
  const fields = progressFields(event)
  return {
    ...fields,
    status: status(event.status),
    error:
      event.status === 'failed'
        ? event.reason
        : event.status === 'completed'
          ? reconciliationFailure(event)
          : undefined
  }
}

function projectInfo(info: PublicDownloadInfo): DownloadProgress {
  return {
    ...progressFields(info),
    status: status(info.status),
    error:
      info.reason ??
      (info.status === 'interrupted' ? DOWNLOAD_INTERRUPTED_ERROR : reconciliationFailure(info))
  }
}

let applicationPromise: Promise<OffGridApplication> | null = null

/**
 * Compose only the real Models domain needed by these integration tests. Starting the complete
 * Desktop root would also start Electron speech IPC, task storage, RAG, Sync and Automation. Those
 * are unrelated native boundaries, and failures there would prevent this suite from reaching the
 * download journey it is meant to prove.
 */
function downloadApplication(): Promise<OffGridApplication> {
  applicationPromise ??= (async () => {
    const [applicationModule, modelServices, downloads, access, modelManager] = await Promise.all([
      import('@offgrid/application'),
      import('../../model-services'),
      import('../desktop-model-download-ports'),
      import('../../composition/application-access'),
      import('../../models-manager')
    ])
    const application = applicationModule.createOffGridApplication({
      models: {
        ...modelServices.desktopModelWorkspacePorts,
        downloads: downloads.desktopModelDownloads.ports,
        activation: { resolve: modelManager.resolveDesktopActivation },
        library: modelManager.desktopModelLibraryPorts
      }
    })
    access.registerDesktopApplication(application)
    // `start` runs the models refresh, which hydrates durable download records left by a previous
    // process. The restart scenarios depend on that: they expect an interrupted record to be listed
    // again after `vi.resetModules()`.
    await application.start()
    return application
  })()
  return applicationPromise
}

async function facade(): Promise<OffGridApplication['models']> {
  return (await downloadApplication()).models
}

/** The catalog request the Desktop download ports resolve, read from the live catalog per call. */
async function requestFor(
  modelId: string
): ReturnType<
  (typeof import('../desktop-model-download-ports'))['desktopModelDownloads']['request']
> {
  const { desktopModelDownloads } = await import('../desktop-model-download-ports')
  return desktopModelDownloads.request(modelId)
}

async function observe(
  modelId: string,
  onProgress: ((progress: DownloadProgress) => void) | undefined,
  run: () => Promise<DownloadResult>
): Promise<DownloadResult> {
  const models = await facade()
  const release = models.events((event) => {
    if (event.type === 'download' && event.event.modelId === modelId) {
      onProgress?.(projectEvent(event.event))
    }
  })
  try {
    return await run()
  } finally {
    release()
  }
}

function result(
  outcome: { ok: true } | { ok: false; failure: Parameters<typeof modelsFailureMessage>[0] }
): DownloadResult {
  return outcome.ok
    ? { success: true }
    : { success: false, error: modelsFailureMessage(outcome.failure) }
}

export function downloadModel(
  modelId: string,
  onProgress?: (progress: DownloadProgress) => void
): Promise<DownloadResult> {
  return observe(modelId, onProgress, async () =>
    result(await (await facade()).downloadAndWait(await requestFor(modelId)))
  )
}

/**
 * Retry the download this model already has a record for. `downloadAndWait` is the same command the
 * Models screen's retry button reaches: for a record in `failed`, `cancelled` or `interrupted` it
 * resumes that manifest rather than enqueueing a second one. The record lookup keeps "retry" honest
 * — retrying a model that was never downloaded is a refusal, not a fresh download.
 */
export function retryDownload(
  modelId: string,
  onProgress?: (progress: DownloadProgress) => void
): Promise<DownloadResult> {
  return observe(modelId, onProgress, async () => {
    const models = await facade()
    const record = models.snapshot().downloads.find((download) => download.modelId === modelId)
    if (!record) return { success: false, error: `No download record for ${modelId}` }
    return result(await models.downloadAndWait(await requestFor(modelId)))
  })
}

export async function downloadStatus(modelId: string): Promise<DownloadProgress | null> {
  const value = (await facade())
    .snapshot()
    .downloads.find((download) => download.modelId === modelId)
  return value ? projectInfo(value) : null
}

export async function listDownloads(): Promise<DownloadProgress[]> {
  return (await facade()).snapshot().downloads.map(projectInfo)
}

export async function clearDownload(
  modelId: string
): Promise<{ success: boolean; error?: string; count?: number; freedBytes?: number }> {
  const models = await facade()
  const record = models.snapshot().downloads.find((download) => download.modelId === modelId)
  if (!record) return { success: false, error: `No download record for ${modelId}` }
  const outcome = await models.clearDownload({ downloadId: record.downloadId })
  return outcome.ok
    ? { success: true, count: outcome.value.count, freedBytes: outcome.value.freedBytes }
    : { success: false, error: modelsFailureMessage(outcome.failure) }
}

export async function shutdownModelDownloads(): Promise<void> {
  await (await downloadApplication()).stop()
}
