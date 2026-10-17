import { modelShowsOnTab } from '../../../shared/model-settings-rules'
import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react'
import { isDecisionModel, useTaskRoles } from '../lib/task-roles'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { Segmented } from '@offgrid/operator-ui/operator/segmented'
import {
  Progress,
  ProgressIndicator,
  ProgressTrack
} from '@offgrid/operator-ui/operator/coss/progress'
import { AnimatedNumber } from '@offgrid/operator-ui/operator/motion/animated-number'
import { TextMorph } from '@offgrid/operator-ui/operator/motion/text-morph'
import { TextShimmer } from '@offgrid/operator-ui/operator/text-shimmer'
import { PageHeader, Section } from '@offgrid/operator-ui/operator/experience'
import { Badge } from '@offgrid/operator-ui/operator/coss/badge'
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle
} from '@offgrid/operator-ui/operator/coss/empty'
import { Card } from '@offgrid/operator-ui/operator/coss/card'
import { Skeleton } from '@offgrid/operator-ui/operator/coss/skeleton'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow
} from '@offgrid/operator-ui/operator/coss/table'
import { AnimatedBackground } from '@offgrid/operator-ui/operator/motion/animated-background'
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput
} from '@offgrid/operator-ui/operator/coss/input-group'
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue
} from '@offgrid/operator-ui/operator/coss/select'
import { Button } from '@offgrid/operator-ui/operator/coss/button'
import { GlyphSwap, IconTip } from './IconTip'
import {
  IconDownload,
  IconCircleCheck,
  IconLoader2,
  IconSearch,
  IconX,
  IconTrash,
  IconUpload,
  IconInfoCircle,
  IconExternalLink,
  IconEye,
  IconDatabase,
  IconStarFilled,
  IconClock,
  IconLayoutGrid,
  IconList,
  IconRefresh,
  IconSettings
} from '@tabler/icons-react'
import { StoragePanel } from './setup/StoragePanel'
import { SidePanel } from './SidePanel'
import { deviceNoun } from '@renderer/lib/device'
import { collectTags, matchesAllTags, toggleTag } from '@renderer/lib/model-tag-filter'
import { companionDownloadLabel } from '@renderer/lib/download-label'
import { formatTransferSpeed } from '@offgrid/sync'
import { projectProgress } from '@offgrid/ui'
import { downloadTimeRemaining } from '@renderer/lib/download-progress'
import { formatParams, isModelWeightFile, modelFileGuidance } from '@renderer/lib/model-summary'
import {
  modelSettingsTabForKind,
  openModelSettingsPanel,
  supportsModelSettings
} from '@renderer/lib/model-settings-panel'
import { fitTier, type FitTier, fitLevel, FIT_OK_FRAC } from '../../../shared/model-fit'
import {
  filterAndSort,
  parseParamCount,
  CREDIBILITY_OPTIONS,
  SIZE_OPTIONS,
  SORT_OPTIONS,
  determineCredibility,
  hasActiveFilters,
  initialFilterState,
  recommendedImageModelId,
  collapseQuantizations,
  huggingFaceRepoFor,
  isOffGridHfRepo,
  type FilterState,
  type Credibility,
  type ModelKind
} from '@offgrid/models'
import {
  useModelDownloadProgress,
  type ModelDownloadProgressEvent
} from '@renderer/hooks/useModelDownloadProgress'
import {
  internalTabFromSubroute,
  internalTabRoutes,
  internalTabSubroute
} from '@renderer/lib/internal-tab-route'
import offGridLogo from '@/assets/logo.png'

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
  const items = allLabel ? [{ key: 'all', label: allLabel }, ...options] : [...options]
  const labelFor = (key: string): string =>
    (items.find((o) => o.key === key) ?? items[0])?.label ?? ''
  return (
    <Select
      value={value}
      onValueChange={(next) => {
        if (next != null) onChange(next)
      }}
      items={items.map((o) => ({ value: o.key, label: o.label }))}
    >
      <SelectTrigger
        size="sm"
        aria-label={prefix ? prefix.replace(/:\s*$/, '') : (allLabel ?? labelFor(value))}
        className="min-h-0 w-auto min-w-0 gap-1 rounded px-2 py-1 text-[10px] sm:min-h-0 sm:text-[10px]"
      >
        <SelectValue>{(key: string) => `${prefix ?? ''}${labelFor(key)}`}</SelectValue>
      </SelectTrigger>
      <SelectPopup>
        {items.map((o) => (
          <SelectItem key={o.key} value={o.key} className="text-[10px] sm:text-[10px]">
            {o.label}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  )
}

// Published full-model MTP exports. Do not redirect a fine-tune to its base model.
const MTP_DOWNLOAD_REPOS: Readonly<Record<string, string>> = {
  'bartowski/tencent_UI-Mate-9B-GGUF': 'bartowski/tencent_UI-Mate-9B-GGUF+MTP',
  ...Object.fromEntries(
    ['0.8B', '2B', '4B', '9B', '27B', '35B-A3B', '122B-A10B', '397B-A17B'].map((size) => [
      `unsloth/Qwen3.5-${size}-GGUF`,
      `unsloth/Qwen3.5-${size}-MTP-GGUF`
    ])
  )
}

interface ModelFile {
  name: string
  url: string
  sizeBytes?: number
  role?: string
}
interface DownloadableModelFile {
  fileName: string
  quant: string
  sizeBytes: number
  mmproj?: { fileName: string; sizeBytes?: number }
}
interface ModelEntry {
  id: string
  sourceModelId?: string
  name: string
  kind: ModelKind
  org?: string
  description?: string
  params?: number
  minRamGb?: number
  isNew?: boolean
  files: ModelFile[]
  imageModes?: string[]
  tags?: string[]
  releaseDate?: string
  quant?: string
  /** Another quantization of this catalog model (one card; the size is picked in the side panel). */
  quantOf?: string
  quantLabel?: string
  availability?: 'ready' | 'coming_soon'
  availabilityNote?: string
  grounder?: boolean
  remoteServerId?: string
  remoteModelId?: string
}
/** A card's model: one catalog entry, with every quantization of it when there is more than one. */
type ShownModel = ModelEntry & { quantOptions?: ModelEntry[] }

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

const BONSAI_2_ID = 'prism-ml/Ternary-Bonsai-2-27B-gguf'
const KEV_4B_ID = 'jaredpalmer/kev-4b'

function featureRank(
  m: { id?: string; sourceModelId?: string; credibility?: string; tags?: string[] },
  recommendedId?: string | null,
  bonsaiRecommended = false
): number {
  // The model recommended for THIS machine's RAM sorts to the very top (above a
  // plain 'Fast' pick). Then distilled few-step models (tagged "Fast") render in
  // ~30s vs ~100s, so surface them next. Then our own org's models, then the rest.
  if (bonsaiRecommended && (m.sourceModelId ?? m.id) === BONSAI_2_ID) return -2
  if (recommendedId && m.id === recommendedId) return -1
  if (m.tags?.some((t) => /^fast/i.test(t))) return 0
  if (m.credibility !== 'offgrid') return 2
  return 1
}

const MODE_LABELS: Record<string, string> = { txt2img: 'Text→Image', img2img: 'Image→Image' }

/** What the card needs to describe a download honestly: one percent for the WHOLE job, the bytes
 *  behind it, which file is in flight and how many the job has, and why it failed if it did. */
interface DownloadCardProgress {
  percent: number
  status?: string
  currentFile?: string
  error?: string
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

/**
 * The progress feed counts in MEBIbytes (1024 * 1024), which is why dividing it by 1024 produced
 * 23.7 for the same 25.4 GB file the meta line described. Convert to bytes on the way in, then the
 * one rule above decides how it reads.
 */
const BYTES_PER_MIB = 1024 * 1024

function formatTransferred(megabytes: string): string {
  const mib = Number(megabytes)
  if (!Number.isFinite(mib)) return `${megabytes} MB`
  return formatSize(mib * BYTES_PER_MIB)
}

/** What part of the model is moving right now, as a quiet tail on the progress line. Empty for the
 *  ordinary single-file case, where naming it adds words and no information. */
function downloadPartLabel(prog: DownloadCardProgress): string {
  const companion = companionDownloadLabel(prog.currentFile)
  if (companion) return `· adding ${companion}`
  if ((prog.fileCount ?? 0) > 1) return `· file ${prog.fileIndex} of ${prog.fileCount}`
  return ''
}

/** Plain words for a download that failed. You need two things from this line: what happened, and
 *  whether trying again is worth it. The raw engine string stays in the title attribute, where it
 *  helps a bug report without shouting at everyone else. */
function downloadFailureText(error?: string): string {
  if (!error) return 'The download did not start.'
  if (error.startsWith('interrupted')) return 'The download stopped before it finished.'
  if (error === 'unknown model') return 'This model is not available to download.'
  return error
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const api = (window as any).api

// The collections chapter's motion: one spring for cards and rows arriving, leaving and reflowing.
const COLLECTION_SPRING = { type: 'spring', stiffness: 380, damping: 32 } as const
const COLLECTION_EASE = [0.16, 1, 0.3, 1] as const
const RISE = {
  initial: { opacity: 0, y: 8, filter: 'blur(4px)' },
  animate: { opacity: 1, y: 0, filter: 'blur(0px)' },
  exit: { opacity: 0, y: -6, filter: 'blur(4px)' },
  transition: { duration: 0.35, ease: COLLECTION_EASE }
}
const ACTIVE_RING =
  'shadow-[inset_0_0_0_1px_rgb(var(--og-rgb-primary)/0.55),0_0_28px_-10px_rgb(var(--og-rgb-primary)/0.8)]'
const MotionRow = motion.create(TableRow)

/** Off Grid AI's own conversions (huggingface.co/off-grid-ai) carry its mark beside the name. */
function isOffGridModel(id: string): boolean {
  return isOffGridHfRepo(id)
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
  // False until the first catalog answer, so the grid draws its shape instead of "no match".
  const [catalogLoaded, setCatalogLoaded] = useState(false)
  const [view, setView] = useState<'grid' | 'list'>('grid')
  const reducedMotion = useReducedMotion()
  const [installed, setInstalled] = useState<string[]>([])
  // Per-model optional companion readiness from the backend (derived from files + disk).
  // Drives repair actions for projectors and DFlash draft models.
  const [visionSt, setVisionSt] = useState<
    Record<
      string,
      {
        supportsVision: boolean
        projectorInstalled: boolean
        supportsDflash?: boolean
        supportsMtp?: boolean
        mtpInstalled?: boolean
        dflashInstalled?: boolean
      }
    >
  >({})
  const refreshVision = (): void => {
    void api.getModelVisionStatus?.().then((s) => setVisionSt(s ?? {}))
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
  // Active model ids across ALL modalities (chat + image/voice/transcription) —
  // one truth from the backend; the UI never re-derives "active" per kind.
  const [activeIds, setActiveIds] = useState<Set<string>>(new Set())
  const isActive = (id: string): boolean => activeIds.has(id)
  // The task models' lineups and each model's roles (Tasks tab), from the same view main builds.
  const [taskRoles, reloadTaskRoles] = useTaskRoles()
  const refreshActive = (): void => {
    void api.getActiveModelIds?.().then((ids: string[]) => setActiveIds(new Set(ids)))
    void reloadTaskRoles()
  }
  const [switching, setSwitching] = useState<string | null>(null)
  const [switchError, setSwitchError] = useState<string | null>(null)
  const [ramGb, setRamGb] = useState<number | null>(null)
  const [importing, setImporting] = useState(false)
  const [useCase, setUseCase] = useState('all')
  // Capability-tag filter (Light / Photoreal / Fast / Anime …). A model must carry
  // every selected tag. Reset when the tab changes so stale tags don't hide the list.
  const [selectedTags, setSelectedTags] = useState<string[]>([])
  useEffect(() => {
    setSelectedTags([])
  }, [activeKind])
  const [detail, setDetail] = useState<ShownModel | null>(null)
  const [deleting, setDeleting] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [mtpDownloads, setMtpDownloads] = useState(false)
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
  const [variantModel, setVariantModel] = useState<ModelEntry | null>(null)
  const [variants, setVariants] = useState<DownloadableModelFile[]>([])
  const [variantLoading, setVariantLoading] = useState(false)
  const [variantError, setVariantError] = useState<string | null>(null)
  const variantGuidance = useMemo(() => modelFileGuidance(variants, ramGb), [variants, ramGb])
  const [detailFiles, setDetailFiles] = useState<DownloadableModelFile[]>([])
  const detailFileGuidance = useMemo(
    () => modelFileGuidance(detailFiles, ramGb),
    [detailFiles, ramGb]
  )
  const [detailFilesLoading, setDetailFilesLoading] = useState(false)
  const [detailFilesError, setDetailFilesError] = useState<string | null>(null)
  const [chosenVariants, setChosenVariants] = useState<Record<string, string>>({})
  const [filterState, setFilterState] = useState<FilterState>(initialFilterState)
  const [sizeBucket, setSizeBucket] = useState<number | null>(null)
  const SIZE_BUCKETS = [2, 4, 6, 8, 16] as const

  const openDetail = useCallback((m: ShownModel) => {
    setDetailFiles([])
    setDetailFilesError(null)
    setDetailFilesLoading(true)
    setDetail(m)
  }, [])

  useEffect(() => {
    const unsubscribe = api.onModelInventoryChanged?.(() => {
      api.getModelCatalog?.().then((catalog: { models: ModelEntry[] }) => setModels(catalog.models))
      api.getInstalledModels?.().then(setInstalled)
      refreshVision()
    })
    return typeof unsubscribe === 'function' ? unsubscribe : undefined
  }, [])

  const closeDetail = useCallback(() => {
    setDetail(null)
  }, [])

  useEffect(() => {
    if (
      !detail ||
      detail.id === KEV_4B_ID ||
      detail.id.startsWith('local:') ||
      !['text', 'vision', 'computer_use'].includes(detail.kind)
    ) {
      setDetailFilesLoading(false)
      return
    }
    if (
      mtpDownloads &&
      !/-MTP-GGUF$/i.test(detail.id) &&
      !detail.id.endsWith('+MTP') &&
      !visionSt[detail.id]?.supportsMtp
    ) {
      setDetailFiles([])
      setDetailFilesError('MTP files are not available for this model.')
      setDetailFilesLoading(false)
      return
    }
    let cancelled = false
    setDetailFiles([])
    setDetailFilesError(null)
    setDetailFilesLoading(true)
    void Promise.resolve(api.getModelFiles?.(detail.id))
      .then((files: DownloadableModelFile[] | undefined) => {
        if (!cancelled) setDetailFiles((files ?? []).filter(isModelWeightFile))
      })
      .catch((error: unknown) => {
        if (!cancelled)
          setDetailFilesError(
            error instanceof Error ? error.message : 'Could not load model files.'
          )
      })
      .finally(() => {
        if (!cancelled) setDetailFilesLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [detail, mtpDownloads, visionSt])

  const importModel = async (): Promise<void> => {
    if (importing) return
    setImporting(true)
    try {
      const res = await api.importLocalModel?.()
      if (res?.success) {
        const c = await api.getModelCatalog?.()
        if (c) {
          setKinds(c.kinds)
          setModels(c.models)
        }
        setInstalled(await api.getInstalledModels?.())
        selectKind('text')
      } else if (res && !res.canceled && res.error) {
        window.alert(`Import failed: ${res.error}`)
      }
    } finally {
      setImporting(false)
    }
  }

  useEffect(() => {
    api
      .systemHealth?.()
      .then((h: { ramGb?: number }) => setRamGb(h.ramGb ?? null))
      .catch(() => {})
    const catalog = api.getModelCatalog?.()
    if (!catalog) setCatalogLoaded(true)
    catalog
      ?.then((c: { kinds: string[]; models: ModelEntry[] }) => {
        setKinds(c.kinds)
        setModels(c.models)
        setActiveKind((current) =>
          current === 'storage' || c.kinds.includes(current) ? current : (c.kinds[0] ?? 'text')
        )
      })
      .finally(() => setCatalogLoaded(true))
    api.getInstalledModels?.().then(setInstalled)
    refreshVision()
    refreshActive()
  }, [])

  useModelDownloadProgress((d: ModelDownloadProgressEvent) => {
    if (d.status === 'cancelled') {
      setProgress((p) => withoutProgressEntry(p, d.modelId))
      return
    }
    const { modelId, ...fields } = d
    setProgress((p) => {
      const prev = p[modelId]
      return {
        ...p,
        [modelId]: {
          ...prev,
          ...fields,
          percent: fields.percent ?? prev?.percent ?? 0,
          currentFile: fields.currentFile ?? prev?.currentFile
        }
      }
    })
    if (d.status === 'completed') {
      api.getModelCatalog?.().then((c: { kinds: string[]; models: ModelEntry[] }) => {
        setKinds(c.kinds)
        setModels(c.models)
      })
      api.getInstalledModels?.().then(setInstalled)
      refreshVision()
      refreshActive()
    }
  })

  const cancelDownload = (id: string): void => {
    void api.cancelModelDownload?.(id)
    setProgress((p) => withoutProgressEntry(p, id))
  }
  const download = (id: string, fileName?: string): void => {
    // 'queued', not 'downloading': nothing has been downloaded yet, and claiming otherwise is what
    // left a refused request showing a spinner at 0% forever. The main process moves it to
    // 'downloading' when bytes actually start, and to 'failed' if it never gets that far.
    setProgress((p) => ({ ...p, [id]: { percent: 0, status: 'queued' } }))
    void Promise.resolve(api.downloadModel?.(id, fileName)).then(
      (r?: { success: boolean; error?: string }) => {
        if (!r || r.success) return
        // You cancelled it, so there is nothing to report: the download resolves unsuccessfully by
        // design, and the progress channel has already cleared the card. Treating that as a failure
        // put a red "cancelled" box under a model you had just chosen to stop.
        if (r.error === 'cancelled') return
        // A refusal also arrives on the progress channel; recording it here too means the card
        // still tells the truth if this window was not listening when the event went out.
        setProgress((p) => ({
          ...p,
          [id]: { ...p[id], percent: 0, status: 'failed', error: r.error }
        }))
      }
    )
  }
  const retryDownload = (id: string): void => {
    setProgress((p) => withoutProgressEntry(p, id))
    download(id, chosenVariants[id])
  }
  const chooseVariant = async (model: ModelEntry): Promise<void> => {
    setVariantModel(model)
    setVariantLoading(true)
    setVariantError(null)
    setVariants([])
    try {
      const files = (await api.getModelFiles?.(model.id))?.filter(isModelWeightFile)
      if (!files?.length) throw new Error('No GGUF files found in this repository.')
      setVariants(files)
    } catch (error) {
      setVariantError(error instanceof Error ? error.message : 'Could not load model files.')
    } finally {
      setVariantLoading(false)
    }
  }
  const removeModel = async (id: string, label: string): Promise<void> => {
    if (!window.confirm(`Delete "${label}"? This removes its files from disk.`)) return
    setDeleting(id)
    try {
      await api.deleteModel?.(id)
      setInstalled(await api.getInstalledModels?.())
      refreshActive()
    } finally {
      setDeleting(null)
    }
  }
  const activateModel = async (id: string): Promise<void> => {
    if (switching) return
    try {
      const fit = await api.estimateModelFit?.(id)
      if (fit && fit.level !== 'ok') {
        if (!window.confirm(`${fit.message}\n\nLoad it anyway?`)) return
      }
    } catch {
      /* best-effort */
    }
    setSwitchError(null)
    setSwitching(id)
    try {
      // Single activation seam — main process routes by kind (chat LLM vs modal default).
      const res =
        activeKind === 'computer_use'
          ? await api.activateModel?.(id, activeKind)
          : await api.activateModel?.(id)
      if (res?.success) refreshActive()
      else setSwitchError(res?.error ? `Couldn't switch: ${res.error}` : "Couldn't switch model")
    } catch (e) {
      setSwitchError(e instanceof Error ? e.message : "Couldn't switch model")
    } finally {
      setSwitching(null)
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
  const totalBytes = (m: { files?: { sizeBytes?: number }[] }): number =>
    (m.files || []).reduce((s, f) => s + (f.sizeBytes || 0), 0)

  useEffect(() => {
    const q = deferredQuery.trim()
    if (!searchEnabled || q.length < 2) {
      setHfResults([])
      // A cleared query asks for no search, so a superseded or cancelled one must not keep spinning.
      setSearching(false)
      return
    }
    setSearching(true)
    // A slow answer for an earlier query must never replace the results the user is looking at:
    // the request is abandoned the moment a newer query supersedes it.
    let live = true
    const t = setTimeout(async () => {
      const res = await api.searchModels?.(q, activeKind)
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
    () => models.filter((model) => modelShowsOnTab(model, activeKind)),
    [models, activeKind]
  )

  // The image model recommended for this machine's RAM (Light Q4 on <=16GB, full
  // Q8 above) — one pure rule, reused for both the badge and the top-of-list sort.
  const recommendedImageId = useMemo(() => recommendedImageModelId(models, ramGb), [models, ramGb])
  const bonsaiFits = (m: ModelEntry): boolean =>
    (m.sourceModelId ?? m.id) === BONSAI_2_ID &&
    ramGb !== null &&
    ramGb >= (m.minRamGb ?? 0) &&
    ['easy', 'fits'].includes(fitTier(totalBytes(m) / 1e9, ramGb))

  const displayed = useMemo(
    () =>
      filterAndSort(
        [
          ...list
            .filter((model) => {
              const name = `${model.name} ${model.id}`.toLowerCase()
              return deferredQuery
                .trim()
                .toLowerCase()
                .split(/\s+/)
                .every((term) => name.includes(term))
            })
            .map((model) => ({
              id: model.id,
              name: model.name,
              org: model.org ?? '',
              downloads: undefined,
              likes: undefined,
              lastModified: undefined,
              credibility: undefined
            })),
          ...hfResults.filter((result) => !list.some((model) => model.id === result.id))
        ].map((r) => ({
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
    [hfResults, filterState, list, deferredQuery]
  )

  // Tags offered as filter chips — every tag present in this tab's models.
  const availableTags = useMemo(() => collectTags(list), [list])

  const displayedCatalog = useMemo(
    () =>
      filterAndSort(
        list.map((m) => ({
          ...m,
          org: m.org ?? '',
          params: m.params ?? parseParamCount(m.name) ?? undefined,
          credibility: determineCredibility((m.id || '').split('/')[0]!)
        })),
        filterState
      )
        .filter((m) => sizeBucket == null || totalBytes(m) <= sizeBucket * 1e9)
        .filter(
          (m) =>
            activeKind !== 'text' || (USE_CASES.find((u) => u.id === useCase)?.match(m) ?? true)
        )
        .filter((m) => matchesAllTags(m.tags, selectedTags))
        .sort((a, b) => {
          // Active first, then other installed, then available — within each tier keep feature rank.
          const rank = (x: { id: string }): number =>
            activeIds.has(x.id) ? 0 : installed.includes(x.id) ? 1 : 2
          return (
            rank(a) - rank(b) ||
            featureRank(a, recommendedImageId, bonsaiFits(a)) -
              featureRank(b, recommendedImageId, bonsaiFits(b))
          )
        }),
    // bonsaiFits reads only ramGb, which is listed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      list,
      filterState,
      sizeBucket,
      activeKind,
      useCase,
      selectedTags,
      activeIds,
      installed,
      recommendedImageId,
      ramGb
    ]
  )

  // One card per model: its quantizations (Full quality, Light) are picked in the side panel. The card
  // stands for the option sorted first (active, installed, recommended), or the one downloading when
  // none is installed yet.
  const displayedModels = useMemo(
    () =>
      collapseQuantizations(displayedCatalog, list, (option) => {
        const p = progress[option.id]
        const isDownloading = !!p && p.status !== 'completed' && p.status !== 'failed'
        const familyInstalled = list.some(
          (entry) =>
            (entry.quantOf ?? entry.id) === (option.quantOf ?? option.id) &&
            installed.includes(entry.id)
        )
        return isDownloading && !familyInstalled
      }),
    [displayedCatalog, list, progress, installed]
  )

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
  const ramTier = (m: { files?: ModelFile[] }): FitTier => {
    if (!ramGb) return 'easy'
    const gb = totalBytes(m) / 1e9
    if (!gb) return 'easy'
    return fitTier(gb, ramGb)
  }

  const renderCard = (
    m: ShownModel & { credibility?: string; params?: number; org?: string },
    isHf = false
  ): React.JSX.Element => {
    // A model with several quantizations is one card, named for the model; the size is chosen in
    // the side panel.
    const choosesQuant = (m.quantOptions?.length ?? 0) > 1
    const useMtpDownloads = mtpDownloads && ['text', 'vision', 'computer_use'].includes(activeKind)
    const mtpRepository = MTP_DOWNLOAD_REPOS[m.id]
    const mtpEntry = mtpRepository ? models.find((model) => model.id === mtpRepository) : undefined
    // "MTP downloads" changes what a NEW download fetches. An installed model keeps its own card (Use,
    // Delete, active state), and a variant that is not ready yet is never offered in its place:
    // swapping either in left an active model looking uninstalled, "coming soon", and unchangeable.
    if (
      useMtpDownloads &&
      mtpEntry &&
      mtpEntry.availability !== 'coming_soon' &&
      !installed.includes(m.id) &&
      !visionSt[m.id]?.mtpInstalled
    ) {
      m = {
        ...m,
        id: mtpEntry.id,
        name: `${m.name} MTP`,
        files: mtpEntry.files,
        availability: mtpEntry.availability ?? m.availability,
        availabilityNote: mtpEntry.availabilityNote ?? m.availabilityNote
      }
    }
    const displayName = choosesQuant ? m.quantOptions![0]!.name : m.name
    const isInstalled =
      installed.includes(m.id) &&
      (!useMtpDownloads || !m.id.endsWith('+MTP') || !!visionSt[m.id]?.mtpInstalled)
    const mtpUnavailable =
      useMtpDownloads &&
      !isInstalled &&
      !/-MTP-GGUF$/i.test(m.id) &&
      !m.id.endsWith('+MTP') &&
      !visionSt[m.id]?.supportsMtp
    const isRemote = Boolean(m.remoteServerId)
    const active = isActive(m.id)
    const prog = progress[m.id]
    const downloading = prog && prog.status !== 'completed' && prog.status !== 'failed'
    const downloadProgress = prog ? projectProgress(prog) : null
    const timeRemaining = downloadProgress ? downloadTimeRemaining(downloadProgress) : null
    // Installed, vision-capable, but the projector isn't on disk (e.g. downloaded before
    // the model gained vision) → offer to fetch just the projector. downloadModel skips
    // files already present, so this pulls only the mmproj.
    const vs = visionSt[m.id]
    const projectorMissing = isInstalled && !!vs?.supportsVision && !vs.projectorInstalled
    const dflashMissing = isInstalled && !!vs?.supportsDflash && !vs.dflashInstalled
    const mtpMissing = isInstalled && !!vs?.supportsMtp && !vs.mtpInstalled
    const bytes = totalBytes(m)
    const size = formatSize(bytes) || null
    const meta = [
      m.org,
      m.params ? formatParams(m.params) : null,
      size,
      fmtReleaseDate(m.releaseDate)
    ]
      .filter(Boolean)
      .join(' · ')
    const tier: FitTier = isHf ? 'easy' : ramTier(m)
    const tags = (m.tags ?? []).filter((t) => !/tight|risky|fit/i.test(t))
    const comingSoon = m.availability === 'coming_soon'
    const worksBest =
      bonsaiFits(m) || /(?:^|[\s/_-])UI[\s_-]?Mate(?:[\s/_-]|$)/i.test(`${m.id} ${m.name}`)
    // The single image pick best-suited to THIS machine's RAM (Light on <=16GB,
    // full above) — a prominent filled-emerald badge, distinct from the outlined tags.
    const recommended =
      !isHf && (bonsaiFits(m) || (!!recommendedImageId && m.id === recommendedImageId))

    // One model, two layouts: the collections chapter's grid card and its table row share every
    // piece below, so a state (downloading, failed, active) reads the same in either view.
    const nameRow = (
      <div className="flex flex-wrap items-center gap-1">
        {isOffGridModel(m.id) && <img src={offGridLogo} alt="Made by Off Grid AI" title="Made by Off Grid AI" className="size-3 shrink-0 rounded-[3px]" />}
        <button
          onClick={() => openDetail(m)}
          className="truncate text-left text-xs text-neutral-100 transition-colors duration-100 hover:text-emerald-500"
        >
          {displayName}
        </button>
        {worksBest && (
          <span className="shrink-0 rounded-sm border border-green-500/60 px-1 py-px text-[8px] uppercase tracking-wide text-green-500">
            Works best
          </span>
        )}
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
    )
    const metaLine = (
      <>{meta && <div className="mt-0.5 truncate text-[10px] text-neutral-600">{meta}</div>}</>
    )
    const detailsButton = (
      <button
        onClick={() => openDetail(m)}
        title="Details"
        className="shrink-0 rounded p-0.5 text-neutral-700 opacity-0 transition-all duration-150 hover:text-neutral-300 active:scale-90 group-hover:opacity-100"
      >
        <IconInfoCircle className="h-3.5 w-3.5" />
      </button>
    )
    const badgeRow = (
      <>
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
              const isFast = /^fast/i.test(t)
              const isLight = /^light$/i.test(t)
              const cls = isFast
                ? 'border border-green-500/60 text-green-500'
                : isLight
                  ? 'border border-emerald-300/50 text-emerald-300'
                  : /challenger/i.test(t)
                    ? 'text-amber-400'
                    : 'bg-neutral-800 text-neutral-500'
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
                    ? `Fits, but context will be tight on this ${deviceNoun()}`
                    : `Past this ${deviceNoun()}'s comfortable ceiling — you can still Load anyway`
                }
              >
                {tier === 'tight' ? 'Tight on RAM' : "Won't fit — Load anyway"}
              </span>
            )}
          </div>
        )}
      </>
    )
    const availabilityNote = (
      <>
        {comingSoon && m.availabilityNote && (
          <p className="text-[9px] leading-relaxed text-neutral-600">{m.availabilityNote}</p>
        )}
      </>
    )
    // The status half of the action row: what is happening to this model right now (coming soon,
    // downloading, failed). Null when there is nothing to say, so a card stays one line shorter.
    const statusNode = comingSoon ? (
      <span className="text-[10px] text-neutral-500">Available after support is fully tested</span>
    ) : active || isInstalled ? null : downloading ? (
      // The percent is NOT in the button: a control whose meaning is "Cancel" is the one place
      // the card's main number should not live.
      <div className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-1.5 gap-y-0.5 text-[10px] text-neutral-500">
        <span className="text-neutral-300">
          {prog.status === 'queued' ? (
            'Queued'
          ) : downloadProgress?.determinate ? (
            <>
              <AnimatedNumber value={Math.round(downloadProgress.percentage ?? 0)} />%
            </>
          ) : (
            <TextShimmer as="span">Downloading</TextShimmer>
          )}
        </span>
        {downloadProgress && downloadProgress.totalBytes !== undefined ? (
          <span className="whitespace-nowrap">
            {formatSize(downloadProgress.currentBytes)} of {formatSize(downloadProgress.totalBytes)}
          </span>
        ) : prog.downloadedMB && prog.totalMB ? (
          <span className="whitespace-nowrap">
            {formatTransferred(prog.downloadedMB)} of {formatTransferred(prog.totalMB)}
          </span>
        ) : null}
        {downloadProgress?.bytesPerSecond !== undefined ? (
          <span className="whitespace-nowrap">
            · {formatTransferSpeed(downloadProgress.bytesPerSecond)}
          </span>
        ) : null}
        {timeRemaining ? <span className="whitespace-nowrap">· {timeRemaining}</span> : null}
        <span className="min-w-0 truncate">{downloadPartLabel(prog)}</span>
      </div>
    ) : prog?.status === 'failed' ? (
      // A failure is a STATE of the action row, not a banner under it: reason here, one retry
      // control in the trailing actions.
      <span
        className="min-w-0 truncate text-[10px] text-red-400/90"
        title={prog.error}
        role="status"
      >
        {downloadFailureText(prog.error)}
      </span>
    ) : null
    // The action half: trailing icon controls (the old label is each one's name and tooltip).
    const actionIcons = (
      <div className="flex shrink-0 items-center gap-1">
        {comingSoon ? null : active ? (
          <span className="flex items-center gap-1 text-[11px] text-green-500">
            <IconCircleCheck className="h-3.5 w-3.5 shrink-0" />{' '}
            {/* A task model says the role it plays, and where: several are active at once. */}
            {(m.kind === 'computer_use' && taskRoles?.badges[m.id]) || 'Active'}
          </span>
        ) : isInstalled ? (
          // Every installed model is activatable for its type — no kind branch.
          // Includes a downloaded HF model (registered as installed), so its search
          // card flips from Download to Use instead of resetting.
          <button
            onClick={() => activateModel(m.id)}
            disabled={!!switching}
            aria-busy={switching === m.id || undefined}
            className="flex items-center gap-1 rounded border border-neutral-700 px-2 py-0.5 text-[10px] text-neutral-300 transition-all duration-150 hover:border-green-500 hover:text-emerald-500 active:scale-95 disabled:opacity-40"
          >
            {switching === m.id ? (
              <>
                <IconLoader2 className="h-3 w-3 animate-spin" />{' '}
                <TextShimmer as="span">Switching</TextShimmer>
              </>
            ) : (
              'Use'
            )}
          </button>
        ) : downloading ? (
          <IconTip label="Cancel">
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label="Cancel"
              onClick={() => cancelDownload(m.id)}
              className="text-neutral-400 hover:text-red-400"
            >
              <GlyphSwap glyphKey={prog.status === 'queued' ? 'queued' : 'running'}>
                {prog.status === 'queued' ? (
                  <IconClock className="h-3.5 w-3.5" />
                ) : (
                  <IconX className="h-3.5 w-3.5" />
                )}
              </GlyphSwap>
            </Button>
          </IconTip>
        ) : prog?.status === 'failed' ? (
          <IconTip label="Try again">
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label="Try again"
              onClick={() => retryDownload(m.id)}
              className="text-neutral-300 hover:text-emerald-500"
            >
              <IconRefresh className="h-3.5 w-3.5" />
            </Button>
          </IconTip>
        ) : (
          <IconTip label={mtpUnavailable ? 'MTP unavailable' : 'Download'}>
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label={mtpUnavailable ? 'MTP unavailable' : 'Download'}
              onClick={() =>
                choosesQuant
                  ? openDetail(m)
                  : isHf || useMtpDownloads
                    ? void chooseVariant(m)
                    : download(m.id)
              }
              disabled={mtpUnavailable}
              className="text-neutral-300 hover:text-emerald-500 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <IconDownload className="h-3.5 w-3.5" />
            </Button>
          </IconTip>
        )}
        {isInstalled && active && !isRemote && supportsModelSettings(m.kind) && (
          <IconTip label="Open settings for the active model">
            <Button
              size="icon-xs"
              variant="ghost"
              onClick={() => openModelSettings(m.kind)}
              aria-label="Open model settings"
              className="text-neutral-500 hover:text-emerald-500"
            >
              <IconSettings className="h-3.5 w-3.5" />
            </Button>
          </IconTip>
        )}
        {isInstalled && !isRemote && !m.id.startsWith('external:') && (
          <button
            onClick={() => removeModel(m.id, m.name)}
            disabled={deleting === m.id || active}
            aria-label="Delete"
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
    )
    const actionRow = (
      <>
        {statusNode ?? <span />}
        {actionIcons}
      </>
    )
    const repairActions = (
      <>
        {/* Vision-capable but projector not downloaded — offer to add it. Hidden while a
            download is in flight (the progress UI covers that). */}
        {!comingSoon && projectorMissing && !dflashMissing && !mtpMissing && !downloading && (
          <button
            onClick={() => download(m.id)}
            title="Download the vision projector so this model can read images"
            className="flex items-center gap-1 rounded border border-amber-400/50 px-2 py-1 text-[10px] text-amber-300 transition-all duration-150 hover:border-amber-400 hover:bg-amber-400/10 active:scale-95"
          >
            <IconEye className="h-3 w-3" /> Add vision support
          </button>
        )}
        {!comingSoon && (dflashMissing || mtpMissing) && !downloading && (
          <button
            onClick={() => download(m.id)}
            title={
              mtpMissing
                ? 'Download the missing MTP file for speculative decoding'
                : 'Download the missing DFlash model for speculative decoding'
            }
            className="flex items-center gap-1 rounded border border-amber-400/50 px-2 py-1 text-[10px] text-amber-300 transition-all duration-150 hover:border-amber-400 hover:bg-amber-400/10 active:scale-95"
          >
            <IconDownload className="h-3 w-3" /> {mtpMissing ? 'Add MTP' : 'Repair'}
          </button>
        )}
      </>
    )
    const progressBar = (
      <>
        {/* Download progress: one bar, one line. It used to be four stacked rows — a percent chip,
            a shouted status, the bytes, then the bar — which said the same thing three times and
            grew the card by half while it ran. The bar carries the shape of the progress, the line
            carries the exact amount, and the part being fetched is named at the end of it where it
            belongs (adding a projector to a model already on disk is not a re-download). */}
        {downloading && (
          <Progress
            aria-label={`${m.name} download progress`}
            value={downloadProgress?.percentage ?? 0}
          >
            <ProgressTrack className="h-0.5">
              <ProgressIndicator
                className={
                  prog.status === 'queued'
                    ? 'bg-primary/40 shadow-none duration-300 ease-out motion-reduce:transition-none'
                    : 'duration-300 ease-out motion-reduce:transition-none'
                }
              />
            </ProgressTrack>
          </Progress>
        )}
      </>
    )

    if (view === 'list') {
      return (
        <MotionRow
          key={m.id}
          layout
          initial={{ opacity: 0, x: -8 }}
          animate={{ opacity: 1, x: 0 }}
          exit={{ opacity: 0, x: 8 }}
          transition={COLLECTION_SPRING}
          data-state={active ? 'selected' : undefined}
          className="group align-top transition-colors"
        >
          <TableCell className="whitespace-normal py-2">
            {nameRow}
            {metaLine}
          </TableCell>
          <TableCell className="whitespace-normal py-2">
            {badgeRow}
            {availabilityNote}
          </TableCell>
          <TableCell className="whitespace-normal py-2">
            {/* Status, actions and any repair on one line; only a running download adds its bar. */}
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <div className="flex min-w-0 flex-1 items-center justify-between gap-2">
                {actionRow}
              </div>
              {repairActions}
              {downloading ? <div className="basis-full">{progressBar}</div> : null}
            </div>
          </TableCell>
          <TableCell className="py-2">{detailsButton}</TableCell>
        </MotionRow>
      )
    }

    return (
      <motion.div
        key={m.id}
        role="listitem"
        layout
        initial={{ opacity: 0, scale: 0.96, filter: 'blur(4px)' }}
        animate={{ opacity: 1, scale: 1, filter: 'blur(0px)' }}
        exit={{ opacity: 0, scale: 0.96, filter: 'blur(4px)' }}
        transition={COLLECTION_SPRING}
        whileHover={reducedMotion ? undefined : { y: -2 }}
        className="group relative"
      >
        <Card
          className={`h-full gap-1.5 p-2.5 transition-shadow duration-300 ${active ? ACTIVE_RING : ''}`}
        >
          {/* Title row: name and meta on the left, the actions trailing on the same line. */}
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0 flex-1">
              {nameRow}
              {metaLine}
            </div>
            {actionIcons}
            {detailsButton}
          </div>
          {badgeRow}
          {availabilityNote}
          {statusNode}
          {repairActions}
          {progressBar}
        </Card>
      </motion.div>
    )
  }

  const GRID = 'grid grid-cols-2 gap-2 px-6 py-3 lg:grid-cols-3 2xl:grid-cols-4'
  // Inside a Section the section carries the side padding.
  const SECTION_GRID = 'grid grid-cols-2 gap-2 lg:grid-cols-3 2xl:grid-cols-4'

  // A named group of models as cards (a list of listitems) or as table rows. Both lay out with the
  // same spring, so filtering or a model changing state reflows its neighbours instead of jumping.
  const renderCollection = (
    label: string,
    items: React.ReactNode,
    gridClassName: string,
    listClassName = ''
  ): React.JSX.Element =>
    view === 'list' ? (
      <div className={listClassName}>
        <Table aria-label={label} className="table-fixed">
          <TableHeader>
            <TableRow>
              <TableHead className="w-[34%]">Model</TableHead>
              <TableHead className="w-[24%]">Labels</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="w-10">
                <span className="sr-only">Details</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            <AnimatePresence mode="popLayout" initial={false}>
              {items}
            </AnimatePresence>
          </TableBody>
        </Table>
      </div>
    ) : (
      <div role="list" aria-label={label} className={`relative ${gridClassName}`}>
        <AnimatePresence mode="popLayout" initial={false}>
          {items}
        </AnimatePresence>
      </div>
    )

  const filtersNarrowing =
    hasActiveFilters(filterState) ||
    sizeBucket !== null ||
    selectedTags.length > 0 ||
    (activeKind === 'text' && useCase !== 'all')
  const clearFilters = (): void => {
    setFilterState(initialFilterState)
    setSizeBucket(null)
    setSelectedTags([])
    setUseCase('all')
  }

  return (
    <div className="flex h-full flex-col font-mono">
      {/* Header */}
      <PageHeader
        className="shrink-0 px-6 pb-4 pt-5"
        title="Models"
        description={`Download, switch, and manage the models that run on this ${deviceNoun()}.`}
        actions={
          <IconTip label={importing ? 'Importing…' : 'Import .gguf'}>
            <Button
              size="icon-sm"
              variant="outline"
              aria-label={importing ? 'Importing…' : 'Import .gguf'}
              aria-busy={importing || undefined}
              onClick={importModel}
              disabled={importing}
              className="text-neutral-400 hover:border-green-500/60 hover:text-emerald-500 disabled:opacity-50"
            >
              <GlyphSwap glyphKey={importing ? 'busy' : 'idle'}>
                {importing ? (
                  <IconLoader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <IconUpload className="h-3.5 w-3.5" />
                )}
              </GlyphSwap>
            </Button>
          </IconTip>
        }
      />

      {/* Tabs */}
      <div className="flex shrink-0 items-center gap-3 border-b border-neutral-800 px-6 py-2">
        <Segmented
          label="Model types"
          size="sm"
          value={activeKind}
          onValueChange={selectKind}
          options={tabs.map(({ id: kind, label }) => ({
            id: kind,
            label: kind === 'storage' ? 'Storage' : label,
            icon:
              kind === 'storage' ? (
                <span className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider">
                  <IconDatabase className="h-3 w-3" /> Storage
                  {/* Live counts: installed, transferring, queued, and failed. */}
                  <span className="ml-1 font-normal normal-case tracking-normal text-neutral-600">
                    {installed.length}
                  </span>
                  {storageCounts.downloading > 0 && (
                    <Badge size="sm" variant="success">
                      {storageCounts.downloading}↓
                    </Badge>
                  )}
                  {storageCounts.queued > 0 && (
                    <Badge size="sm" variant="secondary">
                      {storageCounts.queued} queued
                    </Badge>
                  )}
                  {storageCounts.failed > 0 && (
                    <Badge size="sm" variant="error">
                      {storageCounts.failed}✕
                    </Badge>
                  )}
                </span>
              ) : (
                <span className="text-[10px] uppercase tracking-wider">{label}</span>
              )
          }))}
        />
        {ramGb && activeKind !== 'storage' && (
          <span className="ml-auto text-[9px] text-neutral-700">
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
              <InputGroup data-focus-surface="models-search" className="w-auto rounded">
                <InputGroupAddon>
                  <IconSearch className="h-3 w-3 shrink-0 text-neutral-600" aria-hidden="true" />
                </InputGroupAddon>
                <InputGroupInput
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder={`Search HuggingFace…`}
                  className="w-44 text-[10px]"
                />
                {searching && (
                  <InputGroupAddon align="inline-end">
                    <IconLoader2 className="h-3 w-3 animate-spin text-neutral-600" />
                  </InputGroupAddon>
                )}
              </InputGroup>
            )}
            {['text', 'vision', 'computer_use'].includes(activeKind) && (
              <Button
                size="xs"
                variant={mtpDownloads ? 'secondary' : 'outline'}
                className="text-[10px]"
                aria-pressed={mtpDownloads}
                onClick={() => {
                  setMtpDownloads((enabled) => !enabled)
                  setVariantModel(null)
                  setDetail(null)
                }}
                title="Choose full models with Multi-Token Prediction weights"
              >
                <TextMorph as="span">{`MTP downloads: ${mtpDownloads ? 'On' : 'Off'}`}</TextMorph>
              </Button>
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
            {!searchingMode && (
              <Segmented
                label="Fits in memory"
                size="sm"
                tone="quiet"
                value={sizeBucket === null ? 'any' : String(sizeBucket)}
                onValueChange={(id) => setSizeBucket(id === 'any' ? null : Number(id))}
                options={[
                  { id: 'any', label: 'Any' },
                  ...(SIZE_BUCKETS as readonly number[]).map((b) => ({
                    id: String(b),
                    label: `≤${b}GB`
                  }))
                ]}
              />
            )}
            {hasActiveFilters(filterState) && (
              <IconTip label="Clear">
                <Button
                  size="icon-xs"
                  variant="ghost"
                  aria-label="Clear"
                  onClick={() => {
                    setFilterState(initialFilterState)
                    setSizeBucket(null)
                  }}
                  className="text-neutral-500 hover:text-emerald-500"
                >
                  <IconX className="h-3 w-3" />
                </Button>
              </IconTip>
            )}
            <span className="ml-auto text-[9px] text-muted-foreground">
              <AnimatedNumber value={searchingMode ? displayed.length : displayedCatalog.length} />{' '}
              models
            </span>
            <Segmented
              label="Layout"
              size="sm"
              tone="quiet"
              value={view}
              onValueChange={setView}
              options={[
                { id: 'grid', label: 'Grid view', icon: <IconLayoutGrid className="h-3 w-3" /> },
                { id: 'list', label: 'List view', icon: <IconList className="h-3 w-3" /> }
              ]}
            />
          </div>

          {/* Use-case chips (text only, browse mode) */}
          {activeKind === 'text' && !searchingMode && (
            <div className="flex shrink-0 flex-wrap items-center gap-1 border-b border-neutral-800/40 px-6 py-1.5">
              <Segmented
                label="Use case"
                size="sm"
                value={useCase}
                onValueChange={setUseCase}
                options={USE_CASES.map((u) => ({ id: u.id, label: u.label }))}
              />
              <AnimatePresence mode="wait" initial={false}>
                {useCase !== 'all' && (
                  <motion.span
                    key={useCase}
                    initial={{ opacity: 0, y: 6, filter: 'blur(4px)' }}
                    animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
                    exit={{ opacity: 0, y: -6, filter: 'blur(4px)' }}
                    transition={{ duration: 0.35, ease: [0.16, 1, 0.3, 1] }}
                    className="ml-2 text-[9px] text-neutral-600"
                  >
                    {USE_CASES.find((u) => u.id === useCase)?.blurb}
                  </motion.span>
                )}
              </AnimatePresence>
            </div>
          )}

          {/* Capability-tag chips (all tabs, browse mode) — Light / Photoreal / Fast /
              Anime … A chip narrows the list to models carrying every selected tag. */}
          {!searchingMode && availableTags.length > 0 && (
            <div className="flex shrink-0 flex-wrap items-center gap-1 border-b border-neutral-800/40 px-6 py-1.5">
              {/* One hover light glides from chip to chip (the collections chapter's rows). */}
              <AnimatedBackground
                enableHover
                className="rounded-full bg-[rgb(var(--og-rgb-text)/0.06)]"
                transition={{ type: 'spring', bounce: 0.1, duration: 0.35 }}
              >
                {availableTags.map((t) => (
                  <button
                    key={t}
                    data-id={t}
                    aria-pressed={selectedTags.includes(t)}
                    onClick={() => setSelectedTags((cur) => toggleTag(cur, t))}
                    className={`rounded-full border px-2 py-0.5 text-[9px] uppercase tracking-wide transition-[color,border-color,transform] duration-150 active:scale-95 ${
                      selectedTags.includes(t)
                        ? 'border-primary/60 text-primary'
                        : 'border-border text-muted-foreground hover:text-foreground'
                    }`}
                  >
                    {t}
                  </button>
                ))}
              </AnimatedBackground>
              {selectedTags.length > 0 && (
                <IconTip label="clear">
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    aria-label="clear"
                    onClick={() => setSelectedTags([])}
                    className="ml-1 text-neutral-600 hover:text-neutral-400"
                  >
                    <IconX className="h-3 w-3" />
                  </Button>
                </IconTip>
              )}
            </div>
          )}

          {switchError && (
            <div className="shrink-0 border-b border-red-500/20 bg-red-500/10 px-6 py-1.5 text-[10px] text-red-300">
              {switchError}
            </div>
          )}

          {/* Model grid */}
          <div className="flex-1 overflow-y-auto">
            {searchingMode ? (
              <>
                <AnimatePresence initial={false}>
                  {displayed.length === 0 && !searching && (
                    <motion.div key="no-results" {...RISE}>
                      <Empty className="px-6 py-10 md:py-10">
                        <EmptyHeader>
                          <EmptyMedia variant="icon">
                            <IconSearch />
                          </EmptyMedia>
                          <EmptyTitle className="text-[15px] font-normal">No results</EmptyTitle>
                          <EmptyDescription className="text-xs">
                            No results for &quot;{query}&quot;.
                          </EmptyDescription>
                        </EmptyHeader>
                        <EmptyContent>
                          <Button size="sm" variant="outline" onClick={() => setQuery('')}>
                            Clear search
                          </Button>
                        </EmptyContent>
                      </Empty>
                    </motion.div>
                  )}
                </AnimatePresence>
                {renderCollection(
                  'Model search results',
                  displayed
                    .filter(
                      (result, index, results) =>
                        !mtpDownloads ||
                        results.findIndex(
                          (other) =>
                            (MTP_DOWNLOAD_REPOS[other.id] ?? other.id) ===
                            (MTP_DOWNLOAD_REPOS[result.id] ?? result.id)
                        ) === index
                    )
                    .map((r) =>
                      renderCard(
                        list.find((model) => model.id === r.id) ?? {
                          id: r.id,
                          name: r.name,
                          kind: activeKind as ModelKind,
                          org: r.org,
                          files: [],
                          params: r.params ?? undefined,
                          credibility: r.credibility
                        },
                        !list.some((model) => model.id === r.id)
                      )
                    ),
                  GRID,
                  'px-6 py-3'
                )}
              </>
            ) : (
              (() => {
                if (!catalogLoaded) {
                  // The catalog draws its own shape while it arrives, never a false "no match".
                  return (
                    <div
                      aria-busy="true"
                      aria-label="Loading models"
                      className="grid grid-cols-2 gap-2 px-6 pt-6 lg:grid-cols-3 2xl:grid-cols-4"
                    >
                      {[0, 1, 2, 3, 4, 5].map((card) => (
                        <div key={card} className="space-y-3 rounded-2xl p-3">
                          <Skeleton className="h-3" style={{ width: `${62 - card * 5}%` }} />
                          <Skeleton className="h-2.5 w-2/5" />
                          <div className="flex items-center justify-between pt-3">
                            <Skeleton className="h-6 w-20 rounded-md" />
                            <Skeleton className="h-2.5 w-10" />
                          </div>
                        </div>
                      ))}
                    </div>
                  )
                }
                if (displayedCatalog.length === 0) {
                  return (
                    <motion.div key="no-match" {...RISE}>
                      <Empty className="px-6 py-10 md:py-10">
                        <EmptyHeader>
                          <EmptyMedia variant="icon">
                            <IconSearch />
                          </EmptyMedia>
                          <EmptyTitle className="text-[15px] font-normal">
                            No matching models
                          </EmptyTitle>
                          <EmptyDescription className="text-xs">
                            No models match the current filters.
                          </EmptyDescription>
                        </EmptyHeader>
                        {filtersNarrowing && (
                          <EmptyContent>
                            <Button size="sm" variant="outline" onClick={clearFilters}>
                              Clear filters
                            </Button>
                          </EmptyContent>
                        )}
                      </Empty>
                    </motion.div>
                  )
                }
                // One group of cards, the same rows on every tab: on this device, remote (a saved
                // server's models), available to download, coming soon. `group` names the lists
                // when a tab shows more than one group.
                const cardRows = (models: ModelEntry[], group?: string): React.ReactNode => {
                  const installedModels = models.filter(
                    (m) => installed.includes(m.id) && m.availability !== 'coming_soon'
                  )
                  const localModels = installedModels.filter((m) => !m.remoteServerId)
                  const remoteModels = installedModels.filter((m) => m.remoteServerId)
                  const availableModels = models.filter(
                    (m) => !installed.includes(m.id) && m.availability !== 'coming_soon'
                  )
                  const comingSoonModels = models.filter((m) => m.availability === 'coming_soon')
                  const rows: Array<[string, string, ModelEntry[]]> = [
                    [
                      'On this device',
                      group ? `${group} on this device` : 'Models on this device',
                      localModels
                    ],
                    [
                      'Remote',
                      group ? `Remote ${group.toLowerCase()}` : 'Remote models',
                      remoteModels
                    ],
                    [
                      'Available to download',
                      group ? `${group} available to download` : 'Models available to download',
                      availableModels
                    ],
                    [
                      'Coming soon',
                      group ? `${group} coming soon` : 'Computer Use models coming soon',
                      comingSoonModels
                    ]
                  ]
                  return rows.map(([heading, label, list]) => {
                    if (list.length === 0) return null
                    const collection = renderCollection(
                      label,
                      list.map((m) => renderCard(m)),
                      SECTION_GRID
                    )
                    // A heading over a single model is noise; the list keeps its name for readers.
                    return list.length === 1 ? (
                      <div key={label} className="px-6 pt-6 first:pt-4">
                        {collection}
                      </div>
                    ) : (
                      <Section
                        key={label}
                        label={group ? label : heading}
                        className="px-6 pt-6 first:pt-4"
                      >
                        {collection}
                      </Section>
                    )
                  })
                }
                if (activeKind !== 'computer_use') return <>{cardRows(displayedModels)}</>
                // Tasks: grounding specialists and decision models are different jobs, run side by
                // side, so they are listed apart.
                const groups: Array<[string, ModelEntry[]]> = [
                  ['Grounding specialists', displayedModels.filter((m) => !isDecisionModel(m))],
                  ['Decision models', displayedModels.filter((m) => isDecisionModel(m))]
                ]
                return (
                  <>
                    {groups.map(([group, models]) =>
                      models.length > 0 ? (
                        // One heading per group: each row's label already names the job
                        // ("Grounding specialists on this device"), so no title above it.
                        <section key={group} aria-label={group}>
                          {cardRows(models, group)}
                        </section>
                      ) : null
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
            const isLocal = m.id.startsWith('local:')
            const hfRepo = huggingFaceRepoFor(m.sourceModelId ?? m.id)
            const hfUrl =
              !isLocal && hfRepo.includes('/') ? `https://huggingface.co/${hfRepo}` : null
            const bytes = totalBytes(m)
            const isInstalled = installed.includes(m.id)
            const active = isActive(m.id)
            const prog = progress[m.id]
            const downloading = prog && prog.status !== 'completed' && prog.status !== 'failed'
            const comingSoon = m.availability === 'coming_soon'
            const downloadProgress = prog ? projectProgress(prog) : null
            const quantChoices = (m.quantOptions?.length ?? 0) > 1 ? m.quantOptions! : null
            const rows: [string, string | null][] = [
              ['Source', m.org || (isLocal ? 'Imported' : '—')],
              ['Parameters', m.params ? formatParams(m.params) : null],
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
                      {isOffGridModel(m.id) && <img src={offGridLogo} alt="Made by Off Grid AI" title="Made by Off Grid AI" className="size-3.5 shrink-0 rounded-[3px]" />}
                      <h2 className="truncate text-sm text-white">
                        {quantChoices ? quantChoices[0]!.name : m.name}
                      </h2>
                      {m.kind === 'vision' && (
                        <span className="flex items-center gap-0.5 rounded-sm border border-green-500/60 px-1 py-px text-[8px] uppercase tracking-wide text-green-500">
                          <IconEye className="h-2.5 w-2.5" /> Vision
                        </span>
                      )}
                    </div>
                    <div className="mt-0.5 truncate text-[10px] text-neutral-600">{m.id}</div>
                  </div>
                  <IconTip label="Close">
                    <Button
                      size="icon-xs"
                      variant="ghost"
                      aria-label="Close"
                      onClick={closeDetail}
                      className="text-neutral-400 hover:text-white"
                    >
                      <IconX className="h-3.5 w-3.5" />
                    </Button>
                  </IconTip>
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
                  <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2">
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
                  {quantChoices && (
                    <section aria-label="Quantization" className="mt-3">
                      <p className="text-[9px] uppercase tracking-wide text-neutral-600">
                        Quantization
                      </p>
                      <div role="radiogroup" aria-label="Quantization" className="mt-1.5 space-y-1.5">
                        {quantChoices.map((option) => {
                          const chosen = option.id === m.id
                          const optionState = isActive(option.id)
                            ? 'Active'
                            : installed.includes(option.id)
                              ? 'Installed'
                              : option.id === recommendedImageId
                                ? 'Recommended for you'
                                : null
                          return (
                            <button
                              key={option.id}
                              type="button"
                              role="radio"
                              aria-checked={chosen}
                              onClick={() => setDetail({ ...option, quantOptions: quantChoices })}
                              className={`flex w-full items-center justify-between gap-2 rounded border px-3 py-2 text-left transition-colors duration-150 ${
                                chosen
                                  ? 'border-green-500/60 bg-green-500/5'
                                  : 'border-neutral-800 hover:border-neutral-600'
                              }`}
                            >
                              <span className="min-w-0">
                                <span className="block text-xs text-neutral-200">
                                  {option.quantLabel ?? option.quant ?? option.name}
                                </span>
                                <span className="block text-[10px] text-neutral-500">
                                  {[option.quant, formatSize(totalBytes(option))]
                                    .filter(Boolean)
                                    .join(' · ')}
                                </span>
                              </span>
                              {optionState && (
                                <span className="shrink-0 text-[9px] uppercase tracking-wide text-green-500">
                                  {optionState}
                                </span>
                              )}
                            </button>
                          )
                        })}
                      </div>
                    </section>
                  )}
                  {ramGb && bytes > 0 && (
                    <p className="mt-3 text-[10px] text-neutral-500">
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
                      className="mt-3 flex items-center gap-1 text-[10px] text-green-500 transition-colors duration-150 hover:text-emerald-500"
                    >
                      <IconExternalLink className="h-3 w-3" /> View on Hugging Face
                    </button>
                  )}
                  {m.id === KEV_4B_ID && (
                    <section
                      aria-label="Kev model format"
                      className="mt-3 border-t border-neutral-800 pt-3"
                    >
                      <h3 className="text-[10px] uppercase tracking-wide text-neutral-400">
                        Model format
                      </h3>
                      <p className="mt-2 text-[10px] leading-relaxed text-neutral-400">
                        Kev uses the original Qwen3.5-4B-Base SafeTensors weights. The Qwen 3.5 4B
                        GGUF chat model cannot be reused. GGUF contains quantized weights for
                        llama.cpp, while Kev loads SafeTensors through MLX or Torch.
                      </p>
                      <p className="mt-2 text-[10px] leading-relaxed text-neutral-500">
                        One Qwen base: 9.34 GB across two SafeTensors files, plus a 135 MB Kev
                        adapter. If the compatible SafeTensors base is already on this device, Off
                        Grid AI reuses it.
                      </p>
                    </section>
                  )}
                  {hfUrl &&
                    m.id !== KEV_4B_ID &&
                    ['text', 'vision', 'computer_use'].includes(m.kind) && (
                      <section
                        aria-label="Available model files"
                        className="mt-3 border-t border-neutral-800 pt-3"
                      >
                        <h3 className="mb-2 text-[10px] uppercase tracking-wide text-neutral-400">
                          Available GGUF files
                          {detailFileGuidance.size > 0 ? ` · ${detailFileGuidance.size}` : ''}
                        </h3>
                        {detailFilesLoading && (
                          <p className="text-xs text-neutral-500">Loading available files…</p>
                        )}
                        {detailFilesError && (
                          <p role="alert" className="text-xs text-red-400">
                            {detailFilesError}
                          </p>
                        )}
                        {!detailFilesLoading &&
                          !detailFilesError &&
                          detailFileGuidance.size === 0 && (
                            <p className="text-xs text-neutral-500">
                              No GGUF files found in this repository.
                            </p>
                          )}
                        <div className="space-y-2">
                          {detailFiles
                            .filter(isModelWeightFile)
                            .sort(
                              (a, b) =>
                                Number(!!detailFileGuidance.get(b.fileName)?.labels.length) -
                                Number(!!detailFileGuidance.get(a.fileName)?.labels.length)
                            )
                            .map((file) => {
                              const guidance = detailFileGuidance.get(file.fileName)
                              return (
                                <div
                                  key={file.fileName}
                                  className="flex items-start justify-between gap-2 rounded border border-neutral-800 px-3 py-2"
                                >
                                  <div className="min-w-0">
                                    <p className="break-all text-[11px] text-neutral-200">
                                      {file.fileName}
                                    </p>
                                    {guidance && guidance.labels.length > 0 && (
                                      <div className="mt-1 flex flex-wrap gap-1">
                                        {guidance.labels.map((label) => (
                                          <span
                                            key={label}
                                            title={
                                              label === 'Best balance'
                                                ? 'Balances file size and precision within your estimated RAM budget.'
                                                : label === 'Highest precision'
                                                  ? 'Keeps the most weight precision among these files.'
                                                  : 'The smallest complete model download, including its vision file.'
                                            }
                                            className={`rounded-sm border px-1.5 py-0.5 text-[10px] uppercase tracking-wide ${label.startsWith('Best balance') ? 'border-green-500 bg-green-500/10 text-green-500' : 'border-neutral-700 text-neutral-300'}`}
                                          >
                                            {label}
                                          </span>
                                        ))}
                                      </div>
                                    )}
                                    <p className="mt-1 text-[10px] text-neutral-500">
                                      {guidance?.quant ?? file.quant} · {formatSize(file.sizeBytes)}
                                      {file.mmproj ? ` · includes ${file.mmproj.fileName}` : ''}
                                    </p>
                                    {guidance?.fit === 'risky' && (
                                      <p
                                        className="mt-1 text-[10px] text-neutral-400"
                                        title="Estimated from system RAM and file size. GPU memory and context size also affect memory use."
                                      >
                                        Large for this device
                                      </p>
                                    )}
                                    {guidance?.split && (
                                      <p
                                        className="mt-1 text-[10px] text-neutral-400"
                                        title="All model parts are required."
                                      >
                                        Split model /{' '}
                                        {guidance.weightBytes !== null
                                          ? `${formatSize(guidance.weightBytes)} total`
                                          : 'Total size unavailable'}
                                      </p>
                                    )}
                                  </div>
                                  <IconTip label="Download">
                                    <Button
                                      size="icon-xs"
                                      variant="ghost"
                                      onClick={() => download(m.id, file.fileName)}
                                      disabled={comingSoon || !!downloading || !!detailFilesError}
                                      aria-label={`Download ${file.fileName}`}
                                      className="shrink-0 text-neutral-300 hover:text-green-500 disabled:cursor-not-allowed disabled:opacity-40"
                                    >
                                      <IconDownload className="h-3.5 w-3.5" />
                                    </Button>
                                  </IconTip>
                                </div>
                              )
                            })}
                        </div>
                      </section>
                    )}
                </div>

                <div className="flex items-center gap-2 border-t border-neutral-800 px-5 py-3">
                  {comingSoon ? (
                    <span className="text-xs text-neutral-500">
                      Download and Use unlock after support is fully tested.
                    </span>
                  ) : active ? (
                    <span className="flex items-center gap-1 text-xs text-green-500">
                      <IconCircleCheck className="h-4 w-4" /> Active
                    </span>
                  ) : isInstalled ? (
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
                      {!m.id.startsWith('external:') && (
                        <IconTip label="Delete">
                          <Button
                            size="icon-sm"
                            variant="outline"
                            aria-label="Delete"
                            onClick={() => {
                              void removeModel(m.id, m.name)
                              closeDetail()
                            }}
                            className="border-neutral-800 text-neutral-500 hover:border-red-500/60 hover:text-red-400"
                          >
                            <IconTrash className="h-3.5 w-3.5" />
                          </Button>
                        </IconTip>
                      )}
                    </>
                  ) : downloading ? (
                    <span className="text-xs text-neutral-400">
                      {/* Same rule as the card: the percent is the whole download, and the part
                          being fetched is named beside it, never given a percent of its own. */}
                      {prog.status === 'queued'
                        ? 'Queued'
                        : companionDownloadLabel(prog.currentFile)
                          ? `Downloading ${downloadProgress?.determinate ? `${Math.round(downloadProgress.percentage ?? 0)}%` : ''} · adding ${companionDownloadLabel(prog.currentFile)}`
                          : downloadProgress?.determinate
                            ? `Downloading ${Math.round(downloadProgress.percentage ?? 0)}%…`
                            : 'Downloading…'}
                    </span>
                  ) : (
                    <button
                      onClick={() => {
                        if (hfUrl && !models.some((catalogModel) => catalogModel.id === m.id)) {
                          void chooseVariant(m)
                        } else {
                          download(m.id)
                        }
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
      <AnimatePresence>
        {variantModel && (
          <SidePanel
            key="model-file-picker"
            ariaLabel={`Choose a file for ${variantModel.name}`}
            onClose={() => setVariantModel(null)}
            className="w-[26vw] min-w-[380px]"
          >
            <div className="flex items-start justify-between gap-3 border-b border-neutral-800 px-5 py-4">
              <div>
                <h2 className="text-sm font-medium text-white">Choose a model file</h2>
                <p className="mt-1 text-[10px] text-neutral-500">{variantModel.name}</p>
                <p className="mt-1 break-all text-[10px] text-neutral-500">{variantModel.id}</p>
              </div>
              <button
                onClick={() => setVariantModel(null)}
                aria-label="Close file picker"
                className="text-neutral-500 hover:text-white"
              >
                <IconX className="h-4 w-4" />
              </button>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
              {variantLoading && (
                <p className="text-xs text-neutral-400">Loading available files…</p>
              )}
              {variantError && (
                <p className="text-xs text-red-400" role="alert">
                  {variantError}
                </p>
              )}
              <div className="space-y-2">
                {variants
                  .filter(isModelWeightFile)
                  .sort(
                    (a, b) =>
                      Number(!!variantGuidance.get(b.fileName)?.labels.length) -
                      Number(!!variantGuidance.get(a.fileName)?.labels.length)
                  )
                  .map((variant) => {
                    const guidance = variantGuidance.get(variant.fileName)
                    return (
                      <Button
                        variant="outline"
                        key={variant.fileName}
                        onClick={() => {
                          setChosenVariants((current) => ({
                            ...current,
                            [variantModel.id]: variant.fileName
                          }))
                          download(variantModel.id, variant.fileName)
                          setVariantModel(null)
                        }}
                        className="h-auto w-full flex-col items-start gap-1 whitespace-normal rounded px-3 py-2 text-left leading-normal shadow-none"
                      >
                        <span className="break-all text-[11px] text-neutral-200">
                          {variant.fileName}
                        </span>
                        <span className="text-[10px] text-neutral-400">
                          {formatSize(variant.sizeBytes)}
                        </span>
                        {guidance && (
                          <>
                            {guidance.labels.length > 0 && (
                              <span className="text-[10px] uppercase tracking-wide text-neutral-200">
                                {guidance.labels.join(' / ')}
                              </span>
                            )}
                            <span className="text-[10px] text-neutral-400">{guidance.quant}</span>
                            {guidance.fit === 'risky' && (
                              <span
                                className="text-[10px] text-neutral-400"
                                title="Estimated from system RAM and file size. GPU memory and context size also affect memory use."
                              >
                                Large for this device
                              </span>
                            )}
                            {guidance.split && (
                              <span
                                className="text-[10px] text-neutral-400"
                                title="All model parts are required."
                              >
                                Split model /{' '}
                                {guidance.weightBytes !== null
                                  ? `${formatSize(guidance.weightBytes)} total`
                                  : 'Total size unavailable'}
                              </span>
                            )}
                          </>
                        )}
                        {variant.mmproj && (
                          <span className="break-all text-[9px] text-neutral-500">
                            Includes {variant.mmproj.fileName}
                          </span>
                        )}
                      </Button>
                    )
                  })}
              </div>
            </div>
          </SidePanel>
        )}
      </AnimatePresence>
    </div>
  )
}
