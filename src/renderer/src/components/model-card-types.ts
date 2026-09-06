import type {
  ModelControlCatalogModel,
  ModelsFailure,
  PublicDownloadInfo
} from '@offgrid/application'
import { isActiveDownloadStatus, isLocalLibraryModelId } from '@offgrid/application'

export type ModelEntry = Omit<ModelControlCatalogModel, 'artifacts' | 'imageModes' | 'tags'> & {
  artifacts: Array<ModelControlCatalogModel['artifacts'][number]>
  imageModes?: string[]
  tags?: string[]
}

export function mutableCatalogModel(model: ModelControlCatalogModel): ModelEntry {
  return {
    ...model,
    artifacts: [...model.artifacts],
    imageModes: model.imageModes ? [...model.imageModes] : undefined,
    tags: model.tags ? [...model.tags] : undefined
  }
}

export interface DownloadCardProgress {
  downloadId?: string
  percent?: number
  status?: PublicDownloadInfo['status']
  currentFile?: string
  currentFileRole?: PublicDownloadInfo['currentFileRole']
  failureKind?: ModelsFailure['kind']
  error?: string
  commandError?: string
  downloadedMB?: string
  totalMB?: string
  downloadedBytes?: number
  totalBytes?: number
  bytesPerSecond?: number
  fileIndex?: number
  fileCount?: number
}

export function withoutProgressEntry(
  progress: Record<string, DownloadCardProgress>,
  modelId: string
): Record<string, DownloadCardProgress> {
  const next = { ...progress }
  delete next[modelId]
  return next
}

export function formatModelSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return ''
  return bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${Math.round(bytes / 1e6)} MB`
}

export function modelTotalBytes(model: { artifacts: readonly { sizeBytes?: number }[] }): number {
  return model.artifacts.reduce((sum, artifact) => sum + (artifact.sizeBytes ?? 0), 0)
}

export function formatModelReleaseDate(iso?: string): string {
  if (!iso) return ''
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleDateString('en-US', { month: 'short', year: 'numeric' })
}

export interface ModelDetailIdentity {
  url: string | null
  bytes: number
  rows: [string, string | null][]
}

export function modelDetailIdentity(model: ModelEntry | null): ModelDetailIdentity {
  if (!model) return { url: null, bytes: 0, rows: [] }
  const local = isLocalLibraryModelId(model.id)
  const repository = model.sourceModelId ?? model.id
  const bytes = modelTotalBytes(model)
  const url = !local && repository.includes('/') ? `https://huggingface.co/${repository}` : null
  return {
    url,
    bytes,
    rows: [
      ['Source', model.org || (local ? 'Imported' : '—')],
      ['Parameters', model.params ? `${model.params}B` : null],
      ['Quantization', model.quant || null],
      ['Download', formatModelSize(bytes) || null],
      ['Released', formatModelReleaseDate(model.releaseDate) || null],
      ['Min RAM', model.minRamGb ? `${model.minRamGb} GB` : null]
    ]
  }
}

export interface ModelDetailState {
  installed: boolean
  active: boolean
  progress: DownloadCardProgress | undefined
  downloading: boolean
  comingSoon: boolean
}

export function modelDetailState(input: {
  model: ModelEntry | null
  installed: readonly string[]
  activeIds: ReadonlySet<string>
  progress: Record<string, DownloadCardProgress>
}): ModelDetailState {
  if (!input.model) {
    return {
      installed: false,
      active: false,
      progress: undefined,
      downloading: false,
      comingSoon: false
    }
  }
  const progress = input.progress[input.model.id]
  return {
    installed: input.installed.includes(input.model.id),
    active: input.activeIds.has(input.model.id),
    progress,
    downloading: Boolean(
      progress?.status && (isActiveDownloadStatus(progress.status) || progress.status === 'paused')
    ),
    comingSoon: input.model.availability === 'coming_soon'
  }
}

export function downloadFailureText(progress: DownloadCardProgress): string {
  if (progress.status === 'interrupted') {
    return 'The download stopped before it finished. Try again to pick up where it left off.'
  }
  if (progress.failureKind === 'unknown_model') return 'This model is not available to download.'
  if (!progress.error) return 'The download did not start.'
  return progress.error
}
