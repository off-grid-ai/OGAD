import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react'
import { AnimatePresence } from 'motion/react'
import {
  IconDownload,
  IconCircleCheck,
  IconLoader2,
  IconSearch,
  IconChevronDown,
  IconCheck,
  IconX,
  IconTrash,
  IconUpload,
  IconInfoCircle,
  IconExternalLink,
  IconEye,
  IconDatabase,
  IconStarFilled,
  IconPlayerPause,
  IconPlayerPlay
} from '@tabler/icons-react'
import { StoragePanel } from './setup/StoragePanel'
import { SidePanel } from './SidePanel'
import { deviceNoun } from '@renderer/lib/device'
import { collectTags, matchesAllTags, toggleTag } from '@renderer/lib/model-tag-filter'
import { companionDownloadLabel } from '@renderer/lib/download-label'
import { isActiveDownloadStatus } from '@offgrid/application'
import { projectProgress } from '@offgrid/ui'
import { downloadProgressSummary } from '@renderer/lib/download-progress'
import {
  modelSettingsTabForKind,
  openModelSettingsPanel,
  supportsModelSettings
} from '@renderer/lib/model-settings-panel'
import {
  fitTier,
  type FitTier,
  fitLevel,
  FIT_OK_FRAC,
  modelControlSurfaceForKind,
  catalogEntryRank,
  catalogTagTone,
  visibleCatalogTags,
  type CatalogTagTone,
  isLocalLibraryModelId,
  modelsFailureMessage,
  type ModelControlCatalogModel,
  type ModelControlProjection,
  type ModelControlSuccess,
  type PublicDownloadInfo
} from '@offgrid/application'
import {
  filterAndSort,
  parseParamCount,
  CREDIBILITY_OPTIONS,
  SIZE_OPTIONS,
  SORT_OPTIONS,
  determineCredibility,
  hasActiveFilters,
  initialFilterState,
  modelSupportsKind,
  recommendedImageModelId,
  type FilterState,
  type Credibility,
  type ModelKind,
  type ModelsFailure
} from '@offgrid/application'
import { modelControlClient } from '@renderer/lib/model-control-client'
import {
  internalTabFromSubroute,
  internalTabRoutes,
  internalTabSubroute
} from '@renderer/lib/internal-tab-route'
import { MODEL_FILE_EXTENSION } from '@offgrid/application'

function Sel({
  value,
  onChange,
  options,
  allLabel,
  prefix
}: {
  value: string
  onChange: (v: string) => void
  options: readonly { key: string; label: string }[]
  allLabel?: string
  prefix?: string
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])
  const items = allLabel ? [{ key: 'all', label: allLabel }, ...options] : [...options]
  const current = items.find((o) => o.key === value) ?? items[0]
  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        className={`flex items-center gap-1 rounded border bg-neutral-900/60 px-2 py-1 text-[10px] transition-colors ${open ? 'border-green-500 text-white' : 'border-neutral-800 text-neutral-400 hover:border-neutral-600 hover:text-white'}`}
      >
        <span>
          {prefix ?? ''}
          {current?.label}
        </span>
        <IconChevronDown
          className={`h-2.5 w-2.5 text-neutral-500 transition-transform duration-150 ${open ? 'rotate-180' : ''}`}
        />
      </button>
      {open && (
        <div className="absolute left-0 z-30 mt-1 min-w-[150px] overflow-hidden rounded border border-neutral-800 bg-neutral-950 py-0.5 shadow-xl">
          {items.map((o) => (
            <button
              key={o.key}
              onClick={() => {
                onChange(o.key)
                setOpen(false)
              }}
              className={`flex w-full items-center gap-1.5 px-2.5 py-1 text-left text-[10px] transition-colors hover:bg-neutral-900 ${o.key === value ? 'text-green-500' : 'text-neutral-300'}`}
            >
              <IconCheck
                className={`h-2.5 w-2.5 shrink-0 transition-opacity ${o.key === value ? 'opacity-100' : 'opacity-0'}`}
              />
              {o.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

type ModelEntry = Omit<ModelControlCatalogModel, 'artifacts' | 'imageModes' | 'tags'> & {
  artifacts: Array<ModelControlCatalogModel['artifacts'][number]>
  imageModes?: string[]
  tags?: string[]
}

function mutableCatalogModel(model: ModelControlCatalogModel): ModelEntry {
  return {
    ...model,
    artifacts: [...model.artifacts],
    imageModes: model.imageModes ? [...model.imageModes] : undefined,
    tags: model.tags ? [...model.tags] : undefined
  }
}

interface UseCase {
  id: string
  label: string
  blurb: string
  match: (m: { params?: number; kind?: string }) => boolean
}
const USE_CASES: UseCase[] = [
  { id: 'all', label: 'All', blurb: '', match: () => true },
  {
    id: 'general',
    label: 'General',
    blurb: 'Everyday questions, drafting, and brainstorming.',
    match: () => true
  },
  {
    id: 'coding',
    label: 'Coding',
    blurb: 'Code generation — larger models reason better.',
    match: (m) => (m.params ?? 0) >= 4
  },
  {
    id: 'writing',
    label: 'Writing',
    blurb: 'Long-form drafting — long context helps.',
    match: (m) => (m.params ?? 0) >= 2
  },
  {
    id: 'legal',
    label: 'Legal',
    blurb: `Dense docs, careful reasoning — on-device, nothing leaves your ${deviceNoun()}.`,
    match: (m) => (m.params ?? 0) >= 7
  },
  {
    id: 'vision',
    label: 'Vision',
    blurb: 'Understand images, screenshots, documents.',
    match: (m) => m.kind === 'vision'
  },
  {
    id: 'lightweight',
    label: 'Lightweight',
    blurb: 'Fast, low-memory — for modest machines.',
    match: (m) => (m.params ?? 0) <= 4
  }
]

function fmtReleaseDate(iso?: string): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleDateString('en-US', { month: 'short', year: 'numeric' })
}

// What a tag means is shared (catalogTagTone); how this surface paints it is not.
const TAG_TONE_CLASS: Record<CatalogTagTone, string> = {
  fast: 'border border-green-500/60 text-green-500',
  light: 'border border-emerald-300/50 text-emerald-300',
  challenger: 'text-amber-400',
  plain: 'bg-neutral-800 text-neutral-500'
}

const MODE_LABELS: Record<string, string> = { txt2img: 'Text→Image', img2img: 'Image→Image' }

/** What the card needs to describe a download honestly: one percent for the WHOLE job, the bytes
 *  behind it, which file is in flight and how many the job has, and why it failed if it did. */
interface DownloadCardProgress {
  downloadId?: string
  percent?: number
  /** The download's own lifecycle phase, straight from the event. A typed union, so `cancelled`
   *  and `interrupted` stay distinguishable from a genuine `failed` without reading any text. */
  status?: PublicDownloadInfo['status']
  currentFile?: string
  currentFileRole?: PublicDownloadInfo['currentFileRole']
  /** The typed refusal kind when the REQUEST was refused, so what happened is never re-derived
   *  by comparing the rendered message against a known string. */
  failureKind?: ModelsFailure['kind']
  error?: string
  /** A COMMAND about this download was refused (a cancel that did not take), as opposed to the
   *  transfer itself failing. Kept separate from `status`/`error` on purpose: the transfer is very
   *  likely still running, and marking a live download `failed` to report a failed cancel just
   *  swaps one false projection for another. */
  commandError?: string
  downloadedMB?: string
  totalMB?: string
  downloadedBytes?: number
  totalBytes?: number
  bytesPerSecond?: number
  fileIndex?: number
  fileCount?: number
}

function withoutProgressEntry(
  progress: Record<string, DownloadCardProgress>,
  modelId: string
): Record<string, DownloadCardProgress> {
  const next = { ...progress }
  delete next[modelId]
  return next
}

/**
 * A byte count at human scale, in decimal GB - the ONE size rule on this screen.
 *
 * It was two. The card's meta line divided bytes by 1e9 and the progress line divided megabytes by
 * 1024, so the same file was printed twice on one card in two different units under one label:
 * "25.4GB" above "23.7 GB". Decimal is the correct half - sizeBytes comes from Hugging Face, and
 * that is the number the publisher quotes - so the progress line was the one that lied.
 *
 * Below a gigabyte, MB reads better than "0.4 GB".
 */
function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return ''
  return bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${Math.round(bytes / 1e6)} MB`
}

/** One read-only transfer summary for the catalog card and its detail panel. */
function renderDownloadSummary(prog: DownloadCardProgress, showFile = false): React.JSX.Element {
  const progress = projectProgress(prog)
  const summary = downloadProgressSummary(progress)
  const companion = companionDownloadLabel(prog.currentFileRole)
  const status =
    prog.status === 'preparing'
      ? 'Preparing'
      : prog.status === 'queued'
        ? 'Queued'
        : progress.determinate
          ? `${Math.round(progress.percentage ?? 0)}%`
          : 'Downloading'
  const parts = [
    companion,
    prog.status === 'paused' ? 'Paused' : null,
    status,
    summary.bytes,
    summary.rate,
    summary.timeRemaining
  ].filter(Boolean)
  return (
    <div
      className="grid w-full min-w-0 gap-1 text-[10px] tabular-nums text-neutral-500"
      aria-label="Download progress"
    >
      <div
        className="flex min-w-0 items-baseline gap-1 overflow-hidden whitespace-nowrap text-neutral-400"
        title={parts.join(' · ')}
      >
        {companion && (
          <>
            <span className="shrink-0">{companion}</span>
            <span aria-hidden="true">·</span>
          </>
        )}
        {prog.status === 'paused' && (
          <>
            <span className="shrink-0">Paused</span>
            <span aria-hidden="true">·</span>
          </>
        )}
        <span className="shrink-0 text-neutral-300">{status}</span>
        <span aria-hidden="true">·</span>
        <span>{summary.bytes}</span>
        <span aria-hidden="true">·</span>
        <span>{summary.rate}</span>
        {summary.timeRemaining && (
          <>
            <span aria-hidden="true">·</span>
            <span className="min-w-0 truncate">{summary.timeRemaining}</span>
          </>
        )}
      </div>
      {showFile && prog.currentFile && (
        <div className="mt-1 min-w-0 break-all text-neutral-500" aria-label="Current download file">
          {prog.currentFile}
        </div>
      )}
      {prog.commandError && (
        <span className="min-w-0 truncate text-red-400/90" title={prog.commandError} role="status">
          {prog.commandError}
        </span>
      )}
    </div>
  )
}

/** Plain words for a download that did not finish. You need two things from this line: what
 *  happened, and whether trying again is worth it. The raw engine string stays in the title
 *  attribute, where it helps a bug report without shouting at everyone else.
 *
 *  It decides from the download's own typed status and typed refusal kind. It used to decide by
 *  parsing the message - `error.startsWith('interrupted')` and `error === 'unknown model'` - which
 *  read a rendered sentence as if it were data. The `interrupted` comparison was also already
 *  dead: an interrupted download carries `status: 'interrupted'`, and only `status: 'failed'`
 *  reached this text, so an interrupted row rendered no explanation at all. */
function downloadFailureText(prog: DownloadCardProgress): string {
  if (prog.status === 'interrupted') {
    return 'The download stopped before it finished. Try again to pick up where it left off.'
  }
  if (prog.failureKind === 'unknown_model') return 'This model is not available to download.'
  if (!prog.error) return 'The download did not start.'
  return prog.error
}

/**
 * Read the preload bridge at USE time, never at module load: the bridge is installed on `window`
 * before the renderer mounts, and any consumer that imports this module must see the same object
 * the runtime sees. `IElectronAPI` mirrors the preload `offGridApi`, so no cast is needed.
 */
const bridge = (): IElectronAPI => window.api

/**
 * The two carried-but-not-done outcomes: the command ran, and the model still is not usable.
 * `Outcome.ok` says only that the command was CARRIED - these are precisely the gap between that
 * and the thing the user asked for, and each carries its own `failure` to explain itself.
 */
function carriedButNotActive(
  result: ModelControlSuccess
): result is Extract<
  ModelControlSuccess,
  { status: 'installed_not_active' | 'projector_installed_not_ready' }
> {
  return (
    result.status === 'installed_not_active' || result.status === 'projector_installed_not_ready'
  )
}

export function ModelsScreen({
  navigationSubroute,
  onNavigateSubroute
}: {
  navigationSubroute?: string | null
  onNavigateSubroute?: (subroute: string | null) => void
} = {}): React.JSX.Element {
  const [kinds, setKinds] = useState<string[]>([])
  const [models, setModels] = useState<ModelEntry[]>([])
  const [installed, setInstalled] = useState<string[]>([])
  // Per-model vision readiness from the backend (derived from files + disk): which
  // vision-capable models have their projector downloaded. Drives the "add vision
  // support" affordance for a model installed before it gained a projector.
  const [visionSt, setVisionSt] = useState<
    Record<string, { supportsVision: boolean; projectorInstalled: boolean }>
  >({})
  const refreshVision = (): void => {
    void bridge()
      .getModelVisionStatus()
      .then((s) => setVisionSt(s ?? {}))
  }
  const initialRequestedKind = useRef<string | null>(null)
  const [activeKind, setActiveKind] = useState<string>(() => {
    const requested = window.sessionStorage.getItem('offgrid:models:initial-kind')
    window.sessionStorage.removeItem('offgrid:models:initial-kind')
    initialRequestedKind.current = requested
    return requested || internalTabFromSubroute('models', navigationSubroute ?? null).id
  })
  const selectKind = useCallback(
    (kind: string): void => {
      setActiveKind(kind)
      onNavigateSubroute?.(internalTabSubroute('models', kind))
    },
    [onNavigateSubroute]
  )
  useEffect(() => {
    if (!onNavigateSubroute) return
    if (initialRequestedKind.current) {
      onNavigateSubroute(internalTabSubroute('models', initialRequestedKind.current))
      initialRequestedKind.current = null
      return
    }
    setActiveKind(internalTabFromSubroute('models', navigationSubroute ?? null).id)
  }, [navigationSubroute, onNavigateSubroute])
  const [progress, setProgress] = useState<Record<string, DownloadCardProgress>>({})
  const changingDownloadOwners = useRef(new Map<string, string>())
  const [changingDownloads, setChangingDownloads] = useState<ReadonlySet<string>>(new Set())
  // Active model ids across ALL modalities (chat + image/voice/transcription) —
  // one truth from the backend; the UI never re-derives "active" per kind.
  const [activeIds, setActiveIds] = useState<Set<string>>(new Set())
  const isActive = (id: string): boolean => activeIds.has(id)
  const applyModelControlProjection = useCallback((projection: ModelControlProjection): void => {
    setKinds([...projection.kinds])
    setModels(projection.models.map(mutableCatalogModel))
    setInstalled([...projection.installed])
    setActiveIds(new Set(projection.activeIds))
    setProgress((current) => {
      const next = { ...current }
      const projectedDownloadIds = new Set(projection.downloads.map((row) => row.downloadId))
      for (const [modelId, existing] of Object.entries(current)) {
        // Rows admitted by Shared live only as long as Shared publishes their download identity.
        // Keep a local command refusal, which has no download identity, until the next user action.
        if (existing.downloadId && !projectedDownloadIds.has(existing.downloadId)) {
          delete next[modelId]
        }
      }
      for (const row of projection.downloads) {
        const existing = current[row.modelId]
        if (row.status === 'cancelled' || row.status === 'completed') {
          delete next[row.modelId]
          continue
        }
        next[row.modelId] = {
          ...existing,
          downloadId: row.downloadId,
          status: row.status,
          currentFile: row.currentFile ?? row.fileName,
          currentFileRole: row.currentFileRole,
          downloadedBytes: row.bytesDownloaded,
          totalBytes: row.totalBytes,
          percent: undefined,
          bytesPerSecond: row.status === 'paused' ? undefined : row.bytesPerSecond,
          error: row.reason,
          commandError: existing?.downloadId === row.downloadId ? existing.commandError : undefined
        }
      }
      return next
    })
    setActiveKind((current) =>
      current === 'storage' || projection.kinds.includes(current)
        ? current
        : (projection.kinds[0] ?? 'text')
    )
  }, [])
  useEffect(
    () => modelControlClient.observe(applyModelControlProjection),
    [applyModelControlProjection]
  )
  // -- Request ownership -----------------------------------------------------------------
  // Six paths write the shared projection, and nothing orders them: `model-control-client` is a
  // direct IPC call, and `ModelControlProjection` carries NO revision to compare (checked: kinds,
  // models, installed, activeIds, active, downloads, downloadDurability). So a slow reply from an
  // earlier command can land after a newer one and overwrite fresher state - the click takes, then
  // visibly reverts. `operationId` already exists on every `ModelControlIntent` and is echoed on
  // every `ModelControlSuccess`, so correlation needs no new field, store, cache or diff.
  //
  // There are TWO different questions, and conflating them is what makes per-writer ownership
  // wrong. "May this reply publish shared state?" has ONE answer for the whole screen, because all
  // six writers publish the SAME projection - a per-writer lane would let an old refresh pass its
  // own guard and still overwrite a newer switch. "May this reply clean up ITS OWN spinner or
  // notice?" is per operation, because one modality's stale reply must never strand or unlock
  // another's in-flight work. So: one publication authority, many cleanup lanes.
  /** THE single authority for publishing a projection: the newest intent, whatever produced it. */
  const projectionOwner = useRef<string | null>(null)
  const ownsProjection = useCallback(
    (operationId: string): boolean => projectionOwner.current === operationId,
    []
  )
  /** Per-operation cleanup identity. Downloads are concurrent, so theirs is keyed per model. */
  const switchOwner = useRef<string | null>(null)
  const removeOwner = useRef<string | null>(null)
  const refreshOwner = useRef<string | null>(null)
  const downloadOwners = useRef(new Map<string, string>())
  /** Mint one id, claim the single publication authority with it, and claim its cleanup lane. */
  const claimOperation = useCallback((lane: { current: string | null }): string => {
    const operationId = crypto.randomUUID()
    projectionOwner.current = operationId
    lane.current = operationId
    return operationId
  }, [])
  const claimDownload = useCallback((id: string): string => {
    const operationId = crypto.randomUUID()
    projectionOwner.current = operationId
    downloadOwners.current.set(id, operationId)
    return operationId
  }, [])
  const ownsDownload = (id: string, operationId: string): boolean =>
    downloadOwners.current.get(id) === operationId

  // Declared ahead of every callback that writes them. A dependency array is evaluated DURING
  // render, so a hook or state referenced above its `const` is a mount-time ReferenceError, not a
  // lint nit - that has already shipped from this file once.
  const [switching, setSwitching] = useState<string | null>(null)
  const [switchError, setSwitchError] = useState<string | null>(null)
  /** The refresh notice is its OWN state with its OWN lane. Sharing `switchError` let a stale
   *  refresh overwrite the message about the thing the user just did, and let a "couldn't read
   *  your models" survive a later refresh that read them perfectly well. */
  const [refreshError, setRefreshError] = useState<string | null>(null)

  const refreshModelControl = useCallback(async (): Promise<void> => {
    const operationId = claimOperation(refreshOwner)
    const outcome = await modelControlClient.control({ type: 'refresh', operationId })
    if (!outcome.ok) {
      // UNREAD IS NOT EMPTY. Returning silently left the grid showing whatever it had - or nothing
      // at all - which reads exactly like "you have no models" when the truth is that the inventory
      // could not be read. The reader is told which, in the engine's own words.
      if (refreshOwner.current === operationId) {
        setRefreshError(
          `Couldn't read your installed models: ${modelsFailureMessage(outcome.failure)}`
        )
      }
      return
    }
    // The read SUCCEEDED, so a standing "couldn't read your models" is no longer true. Cleared on
    // this lane's own ownership and independently of publication: whether a newer intent wins the
    // projection has no bearing on whether this inventory read worked.
    if (refreshOwner.current === operationId) setRefreshError(null)
    // The ECHOED id, not the one we issued: it proves this reply answers THIS request rather than
    // an older one arriving late, and that no newer intent of ANY kind has claimed publication.
    if (!ownsProjection(outcome.value.operationId)) return
    // EVERY ModelControlSuccess variant carries a fresh projection, so every carried command
    // reconciles the screen. Narrowing to `completed` first is what let a non-completed answer
    // leave this surface showing state the backend had already moved past.
    applyModelControlProjection(outcome.value.projection)
  }, [applyModelControlProjection, claimOperation, ownsProjection])
  const [ramGb, setRamGb] = useState<number | null>(null)
  const [importing, setImporting] = useState(false)
  const [useCase, setUseCase] = useState('all')
  // Capability-tag filter (Light / Photoreal / Fast / Anime …). A model must carry
  // every selected tag. Reset when the tab changes so stale tags don't hide the list.
  const [selectedTags, setSelectedTags] = useState<string[]>([])
  useEffect(() => {
    setSelectedTags([])
  }, [activeKind])
  const [detail, setDetail] = useState<ModelEntry | null>(null)
  const [deleting, setDeleting] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [hfResults, setHfResults] = useState<
    {
      id: string
      name: string
      org: string
      downloads?: number
      likes?: number
      lastModified?: string
      credibility?: string
    }[]
  >([])
  const [searching, setSearching] = useState(false)
  const [filterState, setFilterState] = useState<FilterState>(initialFilterState)
  const [sizeBucket, setSizeBucket] = useState<number | null>(null)
  const SIZE_BUCKETS = [2, 4, 6, 8, 16] as const

  const openDetail = useCallback((m: ModelEntry) => {
    setDetail(m)
  }, [])

  const closeDetail = useCallback(() => {
    setDetail(null)
  }, [])

  const importModel = async (): Promise<void> => {
    if (importing) return
    setImporting(true)
    try {
      const res = await bridge().importLocalModel()
      if (res?.success) {
        await refreshModelControl()
        selectKind('text')
      } else if (res && !res.canceled && res.error) {
        window.alert(`Import failed: ${res.error}`)
      }
    } finally {
      setImporting(false)
    }
  }

  useEffect(() => {
    bridge()
      .systemHealth()
      .then((h: { ramGb?: number }) => setRamGb(h.ramGb ?? null))
      .catch(() => {})
    void refreshModelControl()
    refreshVision()
  }, [refreshModelControl])

  const changeDownload = (
    id: string,
    type: 'cancel-download' | 'pause-download' | 'resume-download'
  ): void => {
    // NOT erased optimistically. The row is the only honest picture of a transfer that is still
    // running until the cancel is actually accepted, and clearing it first meant a refused cancel
    // left the user believing they had stopped something they had not.
    if (changingDownloadOwners.current.has(id)) return
    const operationId = claimDownload(id)
    changingDownloadOwners.current.set(id, operationId)
    setChangingDownloads(new Set(changingDownloadOwners.current.keys()))
    void modelControlClient
      .control({ type, modelId: progress[id]?.downloadId ?? id, operationId })
      .then((outcome) => {
        if (!outcome.ok) {
          // The COMMAND failed; the DOWNLOAD did not. Its percent, status and byte counts keep
          // coming from the progress stream and are left exactly as they are - marking a live
          // transfer `failed` to report a failed cancel would trade one false projection for
          // another. The refusal goes in its own field instead.
          if (ownsDownload(id, operationId)) {
            setProgress((current) => ({
              ...current,
              [id]: {
                ...current[id],
                percent: current[id]?.percent ?? 0,
                commandError: `Couldn't ${type === 'pause-download' ? 'pause' : type === 'resume-download' ? 'resume' : 'cancel'}: ${modelsFailureMessage(outcome.failure)}`
              }
            }))
          }
          return
        }
        // Accepted: now the row may go, and any stale command message with it.
        if (type === 'cancel-download' && ownsDownload(id, outcome.value.operationId)) {
          setProgress((p) => withoutProgressEntry(p, id))
        }
        if (!ownsProjection(outcome.value.operationId)) return
        applyModelControlProjection(outcome.value.projection)
      })
      .finally(() => {
        if (changingDownloadOwners.current.get(id) !== operationId) return
        changingDownloadOwners.current.delete(id)
        setChangingDownloads(new Set(changingDownloadOwners.current.keys()))
      })
  }
  const renderDownloadActions = (id: string, prog: DownloadCardProgress): React.JSX.Element => (
    <div className="flex shrink-0 items-center gap-0.5">
      {prog.downloadId && prog.status !== 'preparing' && (
        <button
          disabled={changingDownloads.has(id)}
          onClick={() =>
            changeDownload(id, prog.status === 'paused' ? 'resume-download' : 'pause-download')
          }
          aria-label={prog.status === 'paused' ? 'Resume' : 'Pause'}
          title={prog.status === 'paused' ? 'Resume download' : 'Pause download'}
          className="rounded p-1 text-neutral-500 transition-colors duration-150 hover:bg-neutral-800 hover:text-neutral-200 active:scale-90 disabled:opacity-40"
        >
          {prog.status === 'paused' ? (
            <IconPlayerPlay className="h-3.5 w-3.5" />
          ) : (
            <IconPlayerPause className="h-3.5 w-3.5" />
          )}
        </button>
      )}
      {prog.downloadId && prog.status !== 'preparing' && (
        <button
          disabled={changingDownloads.has(id)}
          onClick={() => changeDownload(id, 'cancel-download')}
          aria-label="Cancel"
          title="Cancel download"
          className="rounded p-1 text-neutral-500 transition-colors duration-150 hover:bg-neutral-800 hover:text-red-400 active:scale-90 disabled:opacity-40"
        >
          <IconX className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  )
  const download = (model: ModelEntry, type: 'download' | 'repair-projector' = 'download'): void => {
    const id = model.id
    const operationId = claimDownload(id)
    const primary =
      model.artifacts.find((artifact) => artifact.role === 'primary') ?? model.artifacts[0]
    const command = modelControlClient.control({
      type: type === 'download' ? 'queue-download' : type,
      modelId: id,
      ...(type === 'download' && primary
        ? {
            selection: {
              repositoryId: model.sourceModelId ?? model.id,
              fileName: primary.name
            }
          }
        : {}),
      operationId
    })
    void command.then((outcome) => {
      if (!outcome.ok) {
        // Row cleanup is PER MODEL, not the single publication authority: a stale refusal must
        // not paint red over the row a newer request for this same model is already filling,
        // but another model's download starting is no reason to drop this one's error.
        if (!ownsDownload(id, operationId)) return
        // A refusal that IS a cancellation is not a failure, and must not be dressed as one -
        // the same distinction the setup panel draws. It clears the row exactly like the
        // `cancelled` result below, rather than leaving red text and a "Try again".
        if (outcome.failure.kind === 'cancelled') {
          setProgress((p) => withoutProgressEntry(p, id))
          return
        }
        setProgress((current) => ({
          ...current,
          [id]: {
            ...current[id],
            percent: 0,
            status: outcome.failure.kind === 'interrupted' ? 'interrupted' : 'failed',
            // The kind travels with the message so the card never has to re-read the message.
            failureKind: outcome.failure.kind,
            error: modelsFailureMessage(outcome.failure)
          }
        }))
        return
      }
      const result = outcome.value
      // A cancelled download leaves no row behind. Per-model, for the reason above.
      if (result.status === 'cancelled' && ownsDownload(id, result.operationId)) {
        setProgress((p) => withoutProgressEntry(p, id))
      }
      // Publication is the single authority. A download whose projection is refused here is not
      // lost work: the download-completed subscription calls refreshModelControl, which claims
      // the authority itself and republishes.
      if (!ownsProjection(result.operationId)) return
      // Unconditional across STATUSES: `installed_not_active` and `projector_installed_not_ready`
      // are successful DOWNLOADS - the bytes are on disk - and each carries the projection
      // proving it. Dropping them left a finished download still listed as not installed. They
      // are not reported as download failures here because this command only asked for the
      // download; saying a model is installed but not active is the activation surface's job.
      applyModelControlProjection(result.projection)
    })
  }
  const retryDownload = (model: ModelEntry): void => {
    setProgress((p) => withoutProgressEntry(p, model.id))
    download(model)
  }
  const removeModel = async (id: string, label: string): Promise<void> => {
    if (!window.confirm(`Delete "${label}"? This removes its files from disk.`)) return
    setDeleting(id)
    const operationId = claimOperation(removeOwner)
    try {
      const outcome = await modelControlClient.control({
        type: 'remove',
        modelId: id,
        operationId
      })
      if (!outcome.ok) throw new Error(modelsFailureMessage(outcome.failure))
      if (!ownsProjection(outcome.value.operationId)) {
        // SETTLED BUT UNPUBLISHED. The files are gone in the main process, and unlike a download
        // there is no later model-control projection guaranteed to put that on screen. Left alone
        // the screen would list a deleted model forever. Re-applying the projection we just refused
        // is not the answer - it lost because it is stale - so take a fresh authoritative read,
        // which claims publication normally rather than bypassing it.
        void refreshModelControl()
        return
      }
      // Unconditional across STATUSES, for the same reason as everywhere else: only `completed`
      // was applied, so any other carried outcome left removed files still shown on disk.
      applyModelControlProjection(outcome.value.projection)
    } catch (e) {
      // Previously this threw out of an async function nobody catches - both call sites fire it
      // and drop the promise - so a failed delete was an unhandled rejection and the user saw
      // NOTHING. It reports like every other refusal on this screen.
      if (removeOwner.current !== operationId) return
      setSwitchError(e instanceof Error ? e.message : "Couldn't remove model")
    } finally {
      // Cleanup is per operation, NOT the publication authority: a newer refresh or download taking
      // publication is no reason to leave this delete's spinner running forever.
      if (removeOwner.current === operationId) setDeleting(null)
    }
  }
  const activateModel = async (id: string): Promise<void> => {
    if (switching) return
    setSwitchError(null)
    setSwitching(id)
    const operationId = claimOperation(switchOwner)
    try {
      const surface = modelControlSurfaceForKind(activeKind)
      if (!surface) throw new Error(`Unsupported model control kind: ${activeKind}`)
      let outcome = await modelControlClient.control({
        type: 'activate',
        modelId: id,
        surface,
        operationId
      })
      if (!outcome.ok) throw new Error(modelsFailureMessage(outcome.failure))
      let result = outcome.value
      if (result.status === 'confirmation_required') {
        // The confirmation answer carries a projection too, and declining returns early - so
        // reconcile BEFORE asking, or a declined prompt leaves the screen on stale state. This is
        // a WRITE, so it goes through the same single authority. The prompt itself is untouched.
        if (ownsProjection(result.operationId)) applyModelControlProjection(result.projection)
        if (!window.confirm(`${result.confirmation.message}\n\nLoad it anyway?`)) return
        // The SAME operationId: confirming continues one user intent rather than starting a second,
        // so it keeps the publication authority and the lane it already holds.
        outcome = await modelControlClient.control({
          type: 'confirm-activation',
          confirmationId: result.confirmation.confirmationId,
          operationId
        })
        if (!outcome.ok) throw new Error(modelsFailureMessage(outcome.failure))
        result = outcome.value
      }
      if (ownsProjection(result.operationId)) {
        applyModelControlProjection(result.projection)
      } else {
        // SETTLED BUT UNPUBLISHED - see removeModel. The activation committed in the main process;
        // a newer intent (a download's follow-up refresh, typically) took publication while it was
        // in flight, and that refresh READ PRE-ACTIVATION STATE. With no activation event to
        // subscribe to, the screen would sit on the old active model permanently. Converge with a
        // fresh authoritative read instead of re-applying a projection already judged stale.
        void refreshModelControl()
      }
      // `Outcome.ok` means the command was CARRIED, not that the model is now active. These two
      // statuses ARE that gap: the file is installed but the model did not become active, or the
      // projector is installed and not ready. Each carries its own `failure`, so the reason is the
      // engine's own, not a guess. Silently ignoring them is what made a click look like it did
      // nothing while the backend had in fact moved - the exact defect this pass closes.
      if (switchOwner.current === operationId && carriedButNotActive(result)) {
        setSwitchError(modelsFailureMessage(result.failure))
      }
    } catch (e) {
      // Per operation: a stale refusal must not paint over the notice a newer switch owns.
      if (switchOwner.current !== operationId) return
      setSwitchError(e instanceof Error ? e.message : "Couldn't switch model")
    } finally {
      if (switchOwner.current === operationId) setSwitching(null)
    }
  }
  const openModelSettings = (kind?: string): void => {
    openModelSettingsPanel(modelSettingsTabForKind(kind))
  }

  const searchEnabled = activeKind !== 'voice' && activeKind !== 'transcription'
  // The typed query paints immediately; everything derived from it - the remote search, the
  // filtered grid - follows on the deferred value, so a keystroke never waits on the list.
  const deferredQuery = useDeferredValue(query)
  const searchingMode = searchEnabled && deferredQuery.trim().length >= 2
  const totalBytes = (m: { artifacts: readonly { sizeBytes?: number }[] }): number =>
    m.artifacts.reduce((s, f) => s + (f.sizeBytes || 0), 0)

  useEffect(() => {
    const q = deferredQuery.trim()
    if (!searchEnabled || q.length < 2) {
      setHfResults([])
      return
    }
    setSearching(true)
    // A slow answer for an earlier query must never replace the results the user is looking at:
    // the request is abandoned the moment a newer query supersedes it.
    let live = true
    const t = setTimeout(async () => {
      const res = await bridge().searchModels(q, activeKind)
      if (!live) return
      setHfResults(res ?? [])
      setSearching(false)
    }, 400)
    return () => {
      live = false
      clearTimeout(t)
    }
  }, [deferredQuery, activeKind, searchEnabled])

  const list = useMemo(
    () =>
      models.filter(
        (model) =>
          modelSupportsKind(model, activeKind as Parameters<typeof modelSupportsKind>[1]) ||
          (activeKind === 'text' && modelSupportsKind(model, 'vision'))
      ),
    [models, activeKind]
  )

  // The image model recommended for this machine's RAM (Light Q4 on <=16GB, full
  // Q8 above) — one pure rule, reused for both the badge and the top-of-list sort.
  const recommendedImageId = useMemo(() => recommendedImageModelId(models, ramGb), [models, ramGb])

  const displayed = useMemo(
    () =>
      filterAndSort(
        hfResults.map((r) => ({
          id: r.id,
          name: r.name,
          org: r.org,
          downloads: r.downloads,
          likes: r.likes,
          lastModified: r.lastModified,
          credibility: r.credibility as Credibility | undefined,
          params: parseParamCount(r.name) ?? parseParamCount(r.id)
        })),
        filterState
      ),
    [hfResults, filterState]
  )

  // Tags offered as filter chips — every tag present in this tab's models.
  const availableTags = useMemo(() => collectTags(list), [list])

  const displayedCatalog = useMemo(() => {
    const byId = new Map(list.map((model) => [model.id, model]))
    return filterAndSort(
      list.map((m) => ({
        ...m,
        org: m.org ?? '',
        params: m.params ?? parseParamCount(m.name) ?? undefined,
        files: m.artifacts,
        credibility: determineCredibility((m.id || '').split('/')[0]!)
      })),
      filterState
    )
      .map((model) => byId.get(model.id))
      .filter((model): model is ModelEntry => model !== undefined)
      .filter((m) => sizeBucket == null || totalBytes(m) <= sizeBucket * 1e9)
      .filter(
        (m) => activeKind !== 'text' || (USE_CASES.find((u) => u.id === useCase)?.match(m) ?? true)
      )
      .filter((m) => matchesAllTags(m.tags, selectedTags))
      .sort((a, b) => {
        // Active first, then other installed, then available — within each tier keep feature rank.
        const rank = (x: { id: string }): number =>
          activeIds.has(x.id) ? 0 : installed.includes(x.id) ? 1 : 2
        return (
          rank(a) - rank(b) ||
          catalogEntryRank(a, recommendedImageId) - catalogEntryRank(b, recommendedImageId)
        )
      })
  }, [
    list,
    filterState,
    sizeBucket,
    activeKind,
    useCase,
    selectedTags,
    activeIds,
    installed,
    recommendedImageId
  ])

  const tabs = internalTabRoutes('models').filter(
    ({ id }) => id === 'storage' || kinds.includes(id)
  )

  // Live download summary for the Storage tab label. The manager owns queued vs
  // transferring; this surface only counts its emitted statuses.
  const storageCounts = {
    downloading: Object.values(progress).filter((p) => p.status === 'downloading').length,
    queued: Object.values(progress).filter((p) => p.status === 'queued').length,
    failed: Object.values(progress).filter((p) => p.status === 'failed').length
  }

  // Four-way browse chip: only a model past the AGGRESSIVE ceiling reads "won't
  // fit"; 55-82%-of-RAM models read "tight" and stay loadable (Load anyway) — the
  // never-block posture, more accurate than the old 3-way "may not fit".
  const ramTier = (m: ModelEntry): FitTier => {
    if (!ramGb) return 'easy'
    const gb = totalBytes(m) / 1e9
    if (!gb) return 'easy'
    return fitTier(gb, ramGb)
  }

  const renderCard = (m: ModelEntry, isHf = false): React.JSX.Element => {
    const isInstalled = installed.includes(m.id)
    const isRemote = Boolean(m.remoteServerId)
    const active = isActive(m.id)
    const prog = progress[m.id]
    const downloading =
      prog?.status !== undefined &&
      (isActiveDownloadStatus(prog.status) || prog.status === 'paused')
    const downloadProgress = prog ? projectProgress(prog) : null
    // Installed, vision-capable, but the projector isn't on disk (e.g. downloaded before
    // the model gained vision) → offer to fetch just the projector. downloadModel skips
    // files already present, so this pulls only the mmproj.
    const vs = visionSt[m.id]
    const projectorMissing = isInstalled && !!vs?.supportsVision && !vs.projectorInstalled
    const failedProjector =
      prog?.currentFileRole === 'mmproj' &&
      (prog.status === 'failed' || prog.status === 'interrupted')
    const bytes = totalBytes(m)
    const size = formatSize(bytes) || null
    const meta = [m.org, m.params ? `${m.params}B` : null, size, fmtReleaseDate(m.releaseDate)]
      .filter(Boolean)
      .join(' · ')
    const tier: FitTier = isHf ? 'easy' : ramTier(m)
    const tags = visibleCatalogTags(m.tags)
    const comingSoon = m.availability === 'coming_soon'
    // The single image pick best-suited to THIS machine's RAM (Light on <=16GB,
    // full above) — a prominent filled-emerald badge, distinct from the outlined tags.
    const recommended = !isHf && !!recommendedImageId && m.id === recommendedImageId

    return (
      <div
        key={m.id}
        role="listitem"
        className={`group flex flex-col gap-2 rounded-md border p-3 transition-all duration-150 hover:border-neutral-700 ${active ? 'border-green-500/50 bg-green-500/5' : 'border-neutral-800 bg-neutral-900/40'}`}
      >
        {/* Title row */}
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-1">
              <button
                onClick={() => openDetail(m)}
                className="truncate text-left text-xs text-neutral-100 transition-colors duration-100 hover:text-emerald-500"
              >
                {m.name}
              </button>
              {m.kind === 'vision' && (
                <span className="flex shrink-0 items-center gap-0.5 rounded-sm border border-green-500/60 px-1 py-px text-[8px] uppercase tracking-wide text-green-500">
                  <IconEye className="h-2 w-2" /> Vision
                </span>
              )}
              {m.isNew && (
                <span className="shrink-0 rounded-sm border border-green-500/60 px-1 py-px text-[8px] uppercase tracking-wide text-green-500">
                  New
                </span>
              )}
            </div>
            {meta && <div className="mt-0.5 truncate text-[10px] text-neutral-600">{meta}</div>}
          </div>
          <button
            onClick={() => openDetail(m)}
            title="Details"
            className="shrink-0 rounded p-0.5 text-neutral-700 opacity-0 transition-all duration-150 hover:text-neutral-300 active:scale-90 group-hover:opacity-100"
          >
            <IconInfoCircle className="h-3.5 w-3.5" />
          </button>
        </div>

        {/* Badges row */}
        {(comingSoon ||
          recommended ||
          tags.length > 0 ||
          tier === 'tight' ||
          tier === 'wontFit') && (
          <div className="flex flex-wrap items-center gap-1">
            {comingSoon && (
              <span className="shrink-0 rounded-sm border border-amber-400/60 px-1 py-px text-[8px] uppercase tracking-wide text-amber-400">
                Coming soon
              </span>
            )}
            {recommended && (
              // Prominent FILLED emerald badge — the pick for this machine's RAM,
              // set apart from the outlined capability tags below.
              <span className="flex shrink-0 items-center gap-0.5 rounded-sm bg-green-500 px-1.5 py-px text-[8px] font-semibold uppercase tracking-wide text-black">
                <IconStarFilled className="h-2 w-2" /> Recommended for you
              </span>
            )}
            {tags.map((t) => {
              // "Fast" = distilled few-step model (~30s vs ~100s) — highlight in
              // the emerald brand accent so it reads as the recommended quick pick.
              // "Light" = a smaller/lower-memory quant — amber outline so it reads
              // as the memory-friendly variant (distinct from the emerald "Fast").
              const cls = TAG_TONE_CLASS[catalogTagTone(t)]
              return (
                <span
                  key={t}
                  className={`rounded-sm px-1 py-px text-[8px] uppercase tracking-wide ${cls}`}
                >
                  {t}
                </span>
              )
            })}
            {(tier === 'tight' || tier === 'wontFit') && (
              <span
                className={`rounded-sm px-1.5 py-px text-[8px] uppercase tracking-wide ${
                  tier === 'tight'
                    ? 'border border-amber-400/60 text-amber-400'
                    : 'border border-red-400/60 bg-red-400/10 text-red-400'
                }`}
                title={
                  tier === 'tight'
                    ? 'Fits, but context will be tight on this Mac'
                    : "Past this Mac's comfortable ceiling — you can still Load anyway"
                }
              >
                {tier === 'tight' ? 'Tight on RAM' : "Won't fit — Load anyway"}
              </span>
            )}
          </div>
        )}

        {comingSoon && m.availabilityNote && (
          <p className="text-[9px] leading-relaxed text-neutral-600">{m.availabilityNote}</p>
        )}

        {/* Action row */}
        <div
          className={`mt-auto flex gap-2 pt-1 ${downloading ? 'flex-col items-stretch' : 'items-center justify-between'}`}
        >
          {comingSoon ? (
            <span className="text-[10px] text-neutral-500">
              Available after support is fully tested
            </span>
          ) : active && !downloading ? (
            <span className="flex items-center gap-1 text-[11px] text-green-500">
              <IconCircleCheck className="h-3.5 w-3.5" /> Active
            </span>
          ) : isInstalled && !downloading ? (
            // Every installed model is activatable for its type — no kind branch.
            // Includes a downloaded HF model (registered as installed), so its search
            // card flips from Download to Use instead of resetting.
            <button
              onClick={() => activateModel(m.id)}
              disabled={!!switching}
              className="flex items-center gap-1 rounded border border-neutral-700 px-2.5 py-1 text-[10px] text-neutral-300 transition-all duration-150 hover:border-green-500 hover:text-emerald-500 active:scale-95 disabled:opacity-40"
            >
              {switching === m.id ? (
                <>
                  <IconLoader2 className="h-3 w-3 animate-spin" /> Switching
                </>
              ) : (
                'Use'
              )}
            </button>
          ) : downloading ? (
            // Metrics keep the full card width. Compact controls sit beside the progress bar below.
            renderDownloadSummary(prog)
          ) : prog?.status === 'failed' || prog?.status === 'interrupted' ? (
            // A failure is a STATE of the action row, not a banner under it. As its own block it
            // stacked a second button beneath "Download" and asked you to choose between two ways
            // of doing the same thing. Reason left, one button right, on the row that was already
            // there.
            //
            // `interrupted` shares this row because it wants the same thing - a word and a retry -
            // but not the failure tone: it stopped, it did not break.
            <>
              <span
                className={`min-w-0 truncate text-[10px] ${
                  prog.status === 'interrupted' ? 'text-neutral-400' : 'text-red-400/90'
                }`}
                title={prog.error}
                role="status"
              >
                {downloadFailureText(prog)}
              </span>
              <button
                onClick={() => retryDownload(m)}
                className="flex shrink-0 items-center gap-1 rounded border border-neutral-700 px-2.5 py-1 text-[10px] text-neutral-300 transition-all duration-150 hover:border-green-500 hover:text-emerald-500 active:scale-95"
              >
                <IconDownload className="h-3 w-3" /> Try again
              </button>
            </>
          ) : (
            <button
              onClick={() => download(m)}
              className="flex items-center gap-1 rounded border border-neutral-700 px-2.5 py-1 text-[10px] text-neutral-300 transition-all duration-150 hover:border-green-500 hover:text-emerald-500 active:scale-95"
            >
              <IconDownload className="h-3 w-3" /> Download
            </button>
          )}
          {isInstalled && (
            <div className="flex shrink-0 items-center gap-1">
              {active && !isRemote && supportsModelSettings(m.kind) && (
                <button
                  onClick={() => openModelSettings(m.kind)}
                  aria-label="Open model settings"
                  title="Open settings for the active model"
                  className="rounded border border-neutral-800 px-1.5 py-1 text-[9px] text-neutral-500 transition-all duration-150 hover:border-green-500/60 hover:text-emerald-500 active:scale-95"
                >
                  Settings
                </button>
              )}
              {!isRemote && (
                <button
                  onClick={() => removeModel(m.id, m.name)}
                  disabled={deleting === m.id || active}
                  title={active ? 'Switch to another model before deleting' : 'Delete from disk'}
                  className="rounded p-1 text-neutral-700 transition-all duration-150 hover:text-red-400 active:scale-90 disabled:opacity-30 group-hover:text-neutral-500"
                >
                  {deleting === m.id ? (
                    <IconLoader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    <IconTrash className="h-3 w-3" />
                  )}
                </button>
              )}
            </div>
          )}
        </div>

        {/* Vision-capable but projector not downloaded — offer to add it. Hidden while a
            download is in flight (the progress UI covers that). */}
        {!comingSoon && projectorMissing && !downloading && (
          <div className="grid min-w-0 gap-1">
            {failedProjector && (
              <p className="text-[10px] text-neutral-500" role="status">
                {downloadFailureText(prog)}
              </p>
            )}
            <button
              onClick={() => download(m, 'repair-projector')}
              title="Download the vision projector so this model can read images"
              className="flex items-center gap-1 rounded border border-amber-400/50 px-2 py-1 text-[10px] text-amber-300 transition-all duration-150 hover:border-amber-400 hover:bg-amber-400/10 active:scale-95"
            >
              <IconEye className="h-3 w-3 shrink-0" />{' '}
              {failedProjector ? 'Retry vision support (mmproj)' : 'Add vision support'}
            </button>
          </div>
        )}

        {/* Download progress: one bar, one line. It used to be four stacked rows — a percent chip,
            a shouted status, the bytes, then the bar — which said the same thing three times and
            grew the card by half while it ran. The bar carries the shape of the progress, the line
            carries the exact amount, and the part being fetched is named at the end of it where it
            belongs (adding a projector to a model already on disk is not a re-download). */}
        {downloading && (
          <div className="flex w-full items-center gap-1.5">
            <div className="h-0.5 min-w-0 flex-1 overflow-hidden rounded-full bg-neutral-800">
              <div
                className="h-full w-full origin-left bg-green-500 transition-transform duration-300 ease-out motion-reduce:transition-none"
                style={{ transform: `scaleX(${(downloadProgress?.percentage ?? 0) / 100})` }}
              />
            </div>
            {renderDownloadActions(m.id, prog)}
          </div>
        )}
      </div>
    )
  }

  const GRID = 'grid grid-cols-2 gap-2 px-6 py-3 lg:grid-cols-3 2xl:grid-cols-4'

  return (
    <div className="flex h-full flex-col font-mono">
      {/* Header */}
      <div className="flex shrink-0 items-center justify-between border-b border-neutral-800 px-6 py-3">
        <h1 className="text-xs font-medium uppercase tracking-widest text-neutral-400">Models</h1>
        <div className="flex items-center gap-3">
          <button
            onClick={importModel}
            disabled={importing}
            className="flex items-center gap-1.5 rounded border border-neutral-700 px-2.5 py-1 text-[10px] text-neutral-400 transition-all duration-150 hover:border-green-500/60 hover:text-emerald-500 active:scale-95 disabled:opacity-50"
          >
            {importing ? (
              <IconLoader2 className="h-3 w-3 animate-spin" />
            ) : (
              <IconUpload className="h-3 w-3" />
            )}
            {importing ? 'Importing…' : `Import ${MODEL_FILE_EXTENSION.gguf}`}
          </button>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex shrink-0 items-end gap-0 border-b border-neutral-800 px-6">
        {tabs.map(({ id: kind, label }) => (
          <button
            key={kind}
            aria-current={activeKind === kind ? 'page' : undefined}
            onClick={() => selectKind(kind)}
            className={`flex items-center gap-1.5 px-3 py-2 text-[10px] uppercase tracking-wider transition-colors duration-150 ${activeKind === kind ? 'border-b-2 border-green-500 text-white' : 'text-neutral-500 hover:text-neutral-300'}`}
          >
            {kind === 'storage' ? (
              <>
                <IconDatabase className="h-3 w-3" /> Storage
                {/* Live counts: installed, transferring, queued, and failed. */}
                <span className="ml-1 font-normal normal-case tracking-normal text-neutral-600">
                  {installed.length}
                </span>
                {storageCounts.downloading > 0 && (
                  <span className="rounded-sm bg-green-500/15 px-1 text-[8px] text-green-500">
                    {storageCounts.downloading}↓
                  </span>
                )}
                {storageCounts.queued > 0 && (
                  <span className="rounded-sm bg-neutral-800 px-1 text-[8px] text-neutral-400">
                    {storageCounts.queued} queued
                  </span>
                )}
                {storageCounts.failed > 0 && (
                  <span className="rounded-sm bg-red-500/15 px-1 text-[8px] text-red-400">
                    {storageCounts.failed}✕
                  </span>
                )}
              </>
            ) : (
              label
            )}
          </button>
        ))}
        {ramGb && activeKind !== 'storage' && (
          <span className="ml-auto pb-2 text-[9px] text-neutral-700">
            {ramGb}GB RAM · fits ≤{Math.round(ramGb * FIT_OK_FRAC)}GB
          </span>
        )}
      </div>

      {/* Storage tab */}
      {activeKind === 'storage' && (
        <div className="flex-1 overflow-y-auto px-6 py-4">
          <StoragePanel />
        </div>
      )}

      {/* Catalog tab */}
      {activeKind !== 'storage' && (
        <div className="flex min-h-0 flex-1 flex-col">
          {/* Filter bar */}
          <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-neutral-800/60 px-6 py-2">
            {searchEnabled && (
              <div
                data-focus-surface="models-search"
                className="flex items-center gap-1.5 rounded border border-neutral-800 bg-neutral-900/60 px-2 py-1 focus-within:border-neutral-600"
              >
                <IconSearch className="h-3 w-3 shrink-0 text-neutral-600" />
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder={`Search HuggingFace…`}
                  className="w-44 bg-transparent text-[10px] text-white placeholder-neutral-600 outline-none"
                />
                {searching && <IconLoader2 className="h-3 w-3 animate-spin text-neutral-600" />}
              </div>
            )}
            <Sel
              value={filterState.source}
              onChange={(v) =>
                setFilterState((s) => ({ ...s, source: v as FilterState['source'] }))
              }
              allLabel="All sources"
              options={CREDIBILITY_OPTIONS}
            />
            <Sel
              value={filterState.size}
              onChange={(v) => setFilterState((s) => ({ ...s, size: v as FilterState['size'] }))}
              allLabel="Any size"
              options={SIZE_OPTIONS}
            />
            <Sel
              value={filterState.sort}
              onChange={(v) => setFilterState((s) => ({ ...s, sort: v as FilterState['sort'] }))}
              options={SORT_OPTIONS}
              prefix="Sort: "
            />
            {!searchingMode &&
              (SIZE_BUCKETS as readonly number[]).map((b) => (
                <button
                  key={b}
                  onClick={() => setSizeBucket((c) => (c === b ? null : b))}
                  className={`rounded border px-2 py-0.5 text-[9px] transition-all duration-150 active:scale-95 ${sizeBucket === b ? 'border-green-500 bg-green-500/10 text-green-500' : 'border-neutral-800 text-neutral-500 hover:border-neutral-600 hover:text-neutral-300'}`}
                >
                  ≤{b}GB
                </button>
              ))}
            {hasActiveFilters(filterState) && (
              <button
                onClick={() => {
                  setFilterState(initialFilterState)
                  setSizeBucket(null)
                }}
                className="rounded border border-neutral-800 px-2 py-0.5 text-[9px] text-neutral-500 transition-all duration-150 hover:border-green-500/60 hover:text-emerald-500 active:scale-95"
              >
                Clear
              </button>
            )}
            <span className="ml-auto text-[9px] text-neutral-700">
              {searchingMode ? displayed.length : displayedCatalog.length} models
            </span>
          </div>

          {/* Use-case chips (text only, browse mode) */}
          {activeKind === 'text' && !searchingMode && (
            <div className="flex shrink-0 flex-wrap items-center gap-1 border-b border-neutral-800/40 px-6 py-1.5">
              {USE_CASES.filter((u) => u.id !== 'all').map((u) => (
                <button
                  key={u.id}
                  onClick={() => setUseCase((cur) => (cur === u.id ? 'all' : u.id))}
                  className={`rounded-full border px-2 py-0.5 text-[9px] transition-all duration-150 active:scale-95 ${useCase === u.id ? 'border-green-500 text-green-500' : 'border-neutral-800 text-neutral-600 hover:border-neutral-700 hover:text-neutral-400'}`}
                >
                  {u.label}
                </button>
              ))}
              {useCase !== 'all' && (
                <span className="ml-2 text-[9px] text-neutral-600">
                  {USE_CASES.find((u) => u.id === useCase)?.blurb}
                </span>
              )}
            </div>
          )}

          {/* Capability-tag chips (all tabs, browse mode) — Light / Photoreal / Fast /
              Anime … A chip narrows the list to models carrying every selected tag. */}
          {!searchingMode && availableTags.length > 0 && (
            <div className="flex shrink-0 flex-wrap items-center gap-1 border-b border-neutral-800/40 px-6 py-1.5">
              {availableTags.map((t) => (
                <button
                  key={t}
                  onClick={() => setSelectedTags((cur) => toggleTag(cur, t))}
                  className={`rounded-full border px-2 py-0.5 text-[9px] uppercase tracking-wide transition-all duration-150 active:scale-95 ${
                    selectedTags.includes(t)
                      ? 'border-green-500 text-green-500'
                      : 'border-neutral-800 text-neutral-600 hover:border-neutral-700 hover:text-neutral-400'
                  }`}
                >
                  {t}
                </button>
              ))}
              {selectedTags.length > 0 && (
                <button
                  onClick={() => setSelectedTags([])}
                  className="ml-2 text-[9px] text-neutral-600 transition-colors hover:text-neutral-400"
                >
                  clear
                </button>
              )}
            </div>
          )}

          {switchError && (
            <div className="shrink-0 border-b border-red-500/20 bg-red-500/10 px-6 py-1.5 text-[10px] text-red-300">
              {switchError}
            </div>
          )}

          {refreshError && (
            <div className="shrink-0 border-b border-red-500/20 bg-red-500/10 px-6 py-1.5 text-[10px] text-red-300">
              {refreshError}
            </div>
          )}

          {/* Model grid */}
          <div className="flex-1 overflow-y-auto">
            {searchingMode ? (
              <>
                {displayed.length === 0 && !searching && (
                  <p className="px-6 py-4 text-xs text-neutral-600">
                    No results for &quot;{query}&quot;.
                  </p>
                )}
                <div role="list" aria-label="Model search results" className={GRID}>
                  {displayed.map((r) =>
                    renderCard(
                      {
                        id: r.id,
                        name: r.name,
                        kind: activeKind as ModelKind,
                        org: r.org,
                        artifacts: [],
                        params: r.params ?? undefined
                      },
                      true
                    )
                  )}
                </div>
              </>
            ) : (
              (() => {
                if (displayedCatalog.length === 0) {
                  return (
                    <p className="px-6 py-4 text-xs text-neutral-600">
                      No models match the current filters.
                    </p>
                  )
                }
                const installedModels = displayedCatalog.filter(
                  (m) => installed.includes(m.id) && m.availability !== 'coming_soon'
                )
                const availableModels = displayedCatalog.filter(
                  (m) => !installed.includes(m.id) && m.availability !== 'coming_soon'
                )
                const comingSoonModels = displayedCatalog.filter(
                  (m) => m.availability === 'coming_soon'
                )
                return (
                  <>
                    {installedModels.length > 0 && (
                      <>
                        <div className="px-6 pt-3 text-[9px] uppercase tracking-widest text-neutral-600">
                          On this device
                        </div>
                        <div role="list" aria-label="Models on this device" className={GRID}>
                          {installedModels.map((m) => renderCard(m))}
                        </div>
                      </>
                    )}
                    {availableModels.length > 0 && (
                      <>
                        <div className="px-6 pt-2 text-[9px] uppercase tracking-widest text-neutral-600">
                          Available to download
                        </div>
                        <div role="list" aria-label="Models available to download" className={GRID}>
                          {availableModels.map((m) => renderCard(m))}
                        </div>
                      </>
                    )}
                    {comingSoonModels.length > 0 && (
                      <>
                        <div className="px-6 pt-2 text-[9px] uppercase tracking-widest text-neutral-600">
                          Coming soon
                        </div>
                        <div
                          role="list"
                          aria-label="Computer Use models coming soon"
                          className={GRID}
                        >
                          {comingSoonModels.map((m) => renderCard(m))}
                        </div>
                      </>
                    )}
                  </>
                )
              })()
            )}
          </div>
        </div>
      )}

      {/* Detail slide-over */}
      <AnimatePresence>
        {detail &&
          (() => {
            const m = detail
            const isLocal = isLocalLibraryModelId(m.id)
            const hfRepo = m.sourceModelId ?? m.id
            const hfUrl =
              !isLocal && hfRepo.includes('/') ? `https://huggingface.co/${hfRepo}` : null
            const bytes = totalBytes(m)
            const isInstalled = installed.includes(m.id)
            const active = isActive(m.id)
            const prog = progress[m.id]
            const downloading =
              prog?.status !== undefined &&
              (isActiveDownloadStatus(prog.status) || prog.status === 'paused')
            const comingSoon = m.availability === 'coming_soon'
            const rows: [string, string | null][] = [
              ['Source', m.org || (isLocal ? 'Imported' : '—')],
              ['Parameters', m.params ? `${m.params}B` : null],
              ['Quantization', m.quant || null],
              ['Download', formatSize(bytes) || null],
              ['Released', fmtReleaseDate(m.releaseDate) || null],
              ['Min RAM', m.minRamGb ? `${m.minRamGb} GB` : null]
            ]
            return (
              <SidePanel
                ariaLabel={`${m.name} details`}
                onClose={closeDetail}
                className="w-[26vw] min-w-[380px] font-mono"
              >
                <div className="flex items-start justify-between gap-3 border-b border-neutral-800 px-5 py-4">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <h2 className="truncate text-sm text-white">{m.name}</h2>
                      {m.kind === 'vision' && (
                        <span className="flex items-center gap-0.5 rounded-sm border border-green-500/60 px-1 py-px text-[8px] uppercase tracking-wide text-green-500">
                          <IconEye className="h-2.5 w-2.5" /> Vision
                        </span>
                      )}
                    </div>
                    <div className="mt-0.5 truncate text-[10px] text-neutral-600">{m.id}</div>
                  </div>
                  <button
                    onClick={closeDetail}
                    className="rounded border border-neutral-800 px-2.5 py-1 text-[10px] text-neutral-400 transition-all duration-150 hover:border-neutral-600 hover:text-white active:scale-95"
                  >
                    Close
                  </button>
                </div>

                <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
                  {m.description && (
                    <p className="text-xs leading-relaxed text-neutral-300">{m.description}</p>
                  )}
                  {comingSoon && (
                    <div className="mt-3 rounded border border-amber-400/30 bg-amber-400/5 px-3 py-2">
                      <p className="text-[9px] uppercase tracking-wide text-amber-400">
                        Coming soon
                      </p>
                      <p className="mt-1 text-[10px] leading-relaxed text-neutral-400">
                        {m.availabilityNote ?? 'Support is still being prepared and tested.'}
                      </p>
                    </div>
                  )}
                  <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-2">
                    {rows
                      .filter(([, v]) => v)
                      .map(([k, v]) => (
                        <div key={k}>
                          <dt className="text-[9px] uppercase tracking-wide text-neutral-600">
                            {k}
                          </dt>
                          <dd className="text-xs text-neutral-200">{v}</dd>
                        </div>
                      ))}
                  </dl>
                  {ramGb && bytes > 0 && (
                    <p className="mt-4 text-[10px] text-neutral-500">
                      {fitLevel(bytes / 1e9, ramGb) === 'ok'
                        ? `Comfortable fit on your ${deviceNoun()}.`
                        : fitLevel(bytes / 1e9, ramGb) === 'tight'
                          ? 'Tight on RAM - context will be reduced.'
                          : `Large for your ${deviceNoun()} - may run slowly.`}
                    </p>
                  )}
                  {m.imageModes && m.imageModes.length > 0 && (
                    <div className="mt-3 flex flex-wrap gap-1">
                      {m.imageModes.map((mode) => (
                        <span
                          key={mode}
                          className="rounded-sm border border-green-500/40 px-1.5 py-0.5 text-[9px] uppercase tracking-wide text-green-500"
                        >
                          {MODE_LABELS[mode] ?? mode}
                        </span>
                      ))}
                    </div>
                  )}
                  {hfUrl && (
                    <button
                      onClick={() =>
                        (
                          window as { api?: { openExternal?: (u: string) => void } }
                        ).api?.openExternal?.(hfUrl)
                      }
                      className="mt-4 flex items-center gap-1 text-[10px] text-green-500 transition-colors duration-150 hover:text-emerald-500"
                    >
                      <IconExternalLink className="h-3 w-3" /> View on Hugging Face
                    </button>
                  )}
                </div>

                <div
                  className={`flex gap-2 border-t border-neutral-800 px-5 py-3 ${downloading ? 'flex-col items-stretch' : 'items-center'}`}
                >
                  {comingSoon ? (
                    <span className="text-xs text-neutral-500">
                      Download and Use unlock after support is fully tested.
                    </span>
                  ) : active && !downloading ? (
                    <span className="flex items-center gap-1 text-xs text-green-500">
                      <IconCircleCheck className="h-4 w-4" /> Active
                    </span>
                  ) : isInstalled && !downloading ? (
                    <>
                      <button
                        onClick={() => {
                          void activateModel(m.id)
                          closeDetail()
                        }}
                        disabled={!!switching}
                        className="rounded border border-neutral-700 px-3 py-1.5 text-xs text-white transition-all duration-150 hover:border-green-500 hover:text-emerald-500 active:scale-95 disabled:opacity-50"
                      >
                        Use this model
                      </button>
                      <button
                        onClick={() => {
                          void removeModel(m.id, m.name)
                          closeDetail()
                        }}
                        className="rounded border border-neutral-800 px-3 py-1.5 text-xs text-neutral-500 transition-all duration-150 hover:border-red-500/60 hover:text-red-400 active:scale-95"
                      >
                        Delete
                      </button>
                    </>
                  ) : downloading ? (
                    <>
                      {renderDownloadSummary(prog, true)}
                      <div className="flex w-full items-center gap-2">
                        <div className="h-0.5 min-w-0 flex-1 overflow-hidden rounded-full bg-neutral-800">
                          <div
                            className="h-full w-full origin-left bg-green-500 transition-transform duration-300 ease-out motion-reduce:transition-none"
                            style={{
                              transform: `scaleX(${(projectProgress(prog).percentage ?? 0) / 100})`
                            }}
                          />
                        </div>
                        {renderDownloadActions(m.id, prog)}
                      </div>
                    </>
                  ) : (
                    <button
                      onClick={() => {
                        download(m)
                        closeDetail()
                      }}
                      className="flex items-center gap-1 rounded border border-neutral-700 px-3 py-1.5 text-xs text-white transition-all duration-150 hover:border-green-500 hover:text-emerald-500 active:scale-95"
                    >
                      <IconDownload className="h-3.5 w-3.5" /> Download
                    </button>
                  )}
                </div>
              </SidePanel>
            )
          })()}
      </AnimatePresence>
    </div>
  )
}
