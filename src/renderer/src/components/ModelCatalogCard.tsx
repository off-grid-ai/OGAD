import type { ReactNode } from 'react'
import {
  IconCircleCheck,
  IconDownload,
  IconEye,
  IconInfoCircle,
  IconLoader2,
  IconStarFilled,
  IconTrash
} from '@tabler/icons-react'
import {
  catalogTagTone,
  isActiveDownloadStatus,
  supportsModelSettings,
  visibleCatalogTags,
  type CatalogTagTone,
  type FitTier
} from '@offgrid/application'
import { projectProgress } from '@offgrid/ui'
import { companionDownloadLabel } from '@renderer/lib/download-label'
import { downloadProgressSummary } from '@renderer/lib/download-progress'
import {
  downloadFailureText,
  formatModelReleaseDate,
  formatModelSize,
  modelTotalBytes,
  type DownloadCardProgress,
  type ModelEntry
} from './model-card-types'

const TAG_TONE_CLASS: Record<CatalogTagTone, string> = {
  fast: 'border border-green-500/60 text-green-500',
  light: 'border border-emerald-300/50 text-emerald-300',
  challenger: 'text-amber-400',
  plain: 'bg-neutral-800 text-neutral-500'
}

export function DownloadSummary({
  progress: rawProgress,
  showFile = false
}: {
  progress: DownloadCardProgress
  showFile?: boolean
}): React.JSX.Element {
  const progress = projectProgress(rawProgress)
  const summary = downloadProgressSummary(progress)
  const companion = companionDownloadLabel(rawProgress.currentFileRole)
  const status =
    rawProgress.status === 'preparing'
      ? 'Preparing'
      : rawProgress.status === 'queued'
        ? 'Queued'
        : progress.determinate
          ? `${Math.round(progress.percentage ?? 0)}%`
          : 'Downloading'
  const parts = [
    companion,
    rawProgress.status === 'paused' ? 'Paused' : null,
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
        {companion ? (
          <>
            <span className="shrink-0">{companion}</span>
            <span aria-hidden="true">·</span>
          </>
        ) : null}
        {rawProgress.status === 'paused' ? (
          <>
            <span className="shrink-0">Paused</span>
            <span aria-hidden="true">·</span>
          </>
        ) : null}
        <span className="shrink-0 text-neutral-300">{status}</span>
        <span aria-hidden="true">·</span>
        <span>{summary.bytes}</span>
        <span aria-hidden="true">·</span>
        <span>{summary.rate}</span>
        {summary.timeRemaining ? (
          <>
            <span aria-hidden="true">·</span>
            <span className="min-w-0 truncate">{summary.timeRemaining}</span>
          </>
        ) : null}
      </div>
      {showFile && rawProgress.currentFile ? (
        <div className="mt-1 min-w-0 break-all text-neutral-500" aria-label="Current download file">
          {rawProgress.currentFile}
        </div>
      ) : null}
      {rawProgress.commandError ? (
        <span
          className="min-w-0 truncate text-red-400/90"
          title={rawProgress.commandError}
          role="status"
        >
          {rawProgress.commandError}
        </span>
      ) : null}
    </div>
  )
}

function CardBadges({
  comingSoon,
  recommended,
  tags,
  tier
}: {
  comingSoon: boolean
  recommended: boolean
  tags: string[]
  tier: FitTier
}): React.JSX.Element | null {
  const constrained = tier === 'tight' || tier === 'wontFit'
  if (!comingSoon && !recommended && tags.length === 0 && !constrained) return null
  return (
    <div className="flex flex-wrap items-center gap-1">
      {comingSoon ? (
        <span className="shrink-0 rounded-sm border border-amber-400/60 px-1 py-px text-[8px] uppercase tracking-wide text-amber-400">
          Coming soon
        </span>
      ) : null}
      {recommended ? (
        <span className="flex shrink-0 items-center gap-0.5 rounded-sm bg-green-500 px-1.5 py-px text-[8px] font-semibold uppercase tracking-wide text-black">
          <IconStarFilled className="h-2 w-2" /> Recommended for you
        </span>
      ) : null}
      {tags.map((tag) => (
        <span
          key={tag}
          className={`rounded-sm px-1 py-px text-[8px] uppercase tracking-wide ${TAG_TONE_CLASS[catalogTagTone(tag)]}`}
        >
          {tag}
        </span>
      ))}
      {constrained ? (
        <span
          className={`rounded-sm px-1.5 py-px text-[8px] uppercase tracking-wide ${tier === 'tight' ? 'border border-amber-400/60 text-amber-400' : 'border border-red-400/60 bg-red-400/10 text-red-400'}`}
          title={
            tier === 'tight'
              ? 'Fits, but context will be tight on this Mac'
              : "Past this Mac's comfortable ceiling — you can still Load anyway"
          }
        >
          {tier === 'tight' ? 'Tight on RAM' : "Won't fit — Load anyway"}
        </span>
      ) : null}
    </div>
  )
}

interface CardActionProps {
  model: ModelEntry
  active: boolean
  installed: boolean
  remote: boolean
  downloading: boolean
  progress: DownloadCardProgress | undefined
  switching: string | null
  deleting: string | null
  onActivate: (id: string) => void
  onRetry: (model: ModelEntry) => void
  onDownload: (model: ModelEntry, type?: 'download' | 'repair-projector') => void
  onOpenSettings: (kind?: string) => void
  onRemove: (id: string, label: string) => void
  renderDownloadActions: (id: string, progress: DownloadCardProgress) => ReactNode
}

function PrimaryModelAction(props: CardActionProps): React.JSX.Element {
  if (props.model.availability === 'coming_soon') {
    return (
      <span className="text-[10px] text-neutral-500">Available after support is fully tested</span>
    )
  }
  if (props.active && !props.downloading) {
    return (
      <span className="flex items-center gap-1 text-[11px] text-green-500">
        <IconCircleCheck className="h-3.5 w-3.5" /> Active
      </span>
    )
  }
  if (props.installed && !props.downloading) {
    return (
      <button
        onClick={() => props.onActivate(props.model.id)}
        disabled={Boolean(props.switching)}
        className="flex items-center gap-1 rounded border border-neutral-700 px-2.5 py-1 text-[10px] text-neutral-300 transition-all duration-150 hover:border-green-500 hover:text-emerald-500 active:scale-95 disabled:opacity-40"
      >
        {props.switching === props.model.id ? (
          <>
            <IconLoader2 className="h-3 w-3 animate-spin" /> Switching
          </>
        ) : (
          'Use'
        )}
      </button>
    )
  }
  if (props.downloading && props.progress) return <DownloadSummary progress={props.progress} />
  if (props.progress?.status === 'failed' || props.progress?.status === 'interrupted') {
    return (
      <>
        <span
          className={`min-w-0 truncate text-[10px] ${props.progress.status === 'interrupted' ? 'text-neutral-400' : 'text-red-400/90'}`}
          title={props.progress.error}
          role="status"
        >
          {downloadFailureText(props.progress)}
        </span>
        <button
          onClick={() => props.onRetry(props.model)}
          className="flex shrink-0 items-center gap-1 rounded border border-neutral-700 px-2.5 py-1 text-[10px] text-neutral-300 transition-all duration-150 hover:border-green-500 hover:text-emerald-500 active:scale-95"
        >
          <IconDownload className="h-3 w-3" /> Try again
        </button>
      </>
    )
  }
  return (
    <button
      onClick={() => props.onDownload(props.model)}
      className="flex items-center gap-1 rounded border border-neutral-700 px-2.5 py-1 text-[10px] text-neutral-300 transition-all duration-150 hover:border-green-500 hover:text-emerald-500 active:scale-95"
    >
      <IconDownload className="h-3 w-3" /> Download
    </button>
  )
}

function InstalledActions(props: CardActionProps): React.JSX.Element | null {
  if (!props.installed) return null
  return (
    <div className="flex shrink-0 items-center gap-1">
      {props.active && !props.remote && supportsModelSettings(props.model.kind) ? (
        <button
          onClick={() => props.onOpenSettings(props.model.kind)}
          aria-label="Open model settings"
          title="Open settings for the active model"
          className="rounded border border-neutral-800 px-1.5 py-1 text-[9px] text-neutral-500 transition-all duration-150 hover:border-green-500/60 hover:text-emerald-500 active:scale-95"
        >
          Settings
        </button>
      ) : null}
      {!props.remote ? (
        <button
          onClick={() => props.onRemove(props.model.id, props.model.name)}
          disabled={props.deleting === props.model.id || props.active}
          title={props.active ? 'Switch to another model before deleting' : 'Delete from disk'}
          className="rounded p-1 text-neutral-700 transition-all duration-150 hover:text-red-400 active:scale-90 disabled:opacity-30 group-hover:text-neutral-500"
        >
          {props.deleting === props.model.id ? (
            <IconLoader2 className="h-3 w-3 animate-spin" />
          ) : (
            <IconTrash className="h-3 w-3" />
          )}
        </button>
      ) : null}
    </div>
  )
}

function downloadActive(progress: DownloadCardProgress | undefined): boolean {
  return Boolean(
    progress?.status && (isActiveDownloadStatus(progress.status) || progress.status === 'paused')
  )
}

function VisionSupport({
  model,
  visible,
  failed,
  progress,
  onDownload
}: {
  model: ModelEntry
  visible: boolean
  failed: boolean
  progress: DownloadCardProgress | undefined
  onDownload: CardActionProps['onDownload']
}): React.JSX.Element | null {
  if (!visible) return null
  return (
    <div className="grid min-w-0 gap-1">
      {failed && progress ? (
        <p className="text-[10px] text-neutral-500" role="status">
          {downloadFailureText(progress)}
        </p>
      ) : null}
      <button
        onClick={() => onDownload(model, 'repair-projector')}
        title="Download the vision projector so this model can read images"
        className="flex items-center gap-1 rounded border border-amber-400/50 px-2 py-1 text-[10px] text-amber-300 transition-all duration-150 hover:border-amber-400 hover:bg-amber-400/10 active:scale-95"
      >
        <IconEye className="h-3 w-3 shrink-0" />{' '}
        {failed ? 'Retry vision support (mmproj)' : 'Add vision support'}
      </button>
    </div>
  )
}

export interface ModelCatalogCardProps extends CardActionProps {
  isHf?: boolean
  recommendedImageId: string | null
  visionStatus: { supportsVision: boolean; projectorInstalled: boolean } | undefined
  ramTier: (model: ModelEntry) => FitTier
  onOpen: (model: ModelEntry) => void
}

function projectorProjection(props: ModelCatalogCardProps): {
  missing: boolean
  failed: boolean
} {
  return {
    missing:
      props.installed &&
      Boolean(props.visionStatus?.supportsVision) &&
      !props.visionStatus?.projectorInstalled,
    failed:
      props.progress?.currentFileRole === 'mmproj' &&
      (props.progress.status === 'failed' || props.progress.status === 'interrupted')
  }
}

function modelMetadata(model: ModelEntry): string {
  const size = formatModelSize(modelTotalBytes(model)) || null
  return [
    model.org,
    model.params ? `${model.params}B` : null,
    size,
    formatModelReleaseDate(model.releaseDate)
  ]
    .filter(Boolean)
    .join(' · ')
}

function catalogPresentation(props: ModelCatalogCardProps): {
  tier: FitTier
  recommended: boolean
} {
  return {
    tier: props.isHf ? 'easy' : props.ramTier(props.model),
    recommended: !props.isHf && props.model.id === props.recommendedImageId
  }
}

export function ModelCatalogCard(props: ModelCatalogCardProps): React.JSX.Element {
  const { model } = props
  const downloading = downloadActive(props.progress)
  const projector = projectorProjection(props)
  const meta = modelMetadata(model)
  const { tier, recommended } = catalogPresentation(props)
  const tags = visibleCatalogTags(model.tags)
  const comingSoon = model.availability === 'coming_soon'
  return (
    <div
      role="listitem"
      className={`group flex flex-col gap-2 rounded-md border p-3 transition-all duration-150 hover:border-neutral-700 ${props.active ? 'border-green-500/50 bg-green-500/5' : 'border-neutral-800 bg-neutral-900/40'}`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1">
            <button
              onClick={() => props.onOpen(model)}
              className="truncate text-left text-xs text-neutral-100 transition-colors duration-100 hover:text-emerald-500"
            >
              {model.name}
            </button>
            {model.kind === 'vision' ? (
              <span className="flex shrink-0 items-center gap-0.5 rounded-sm border border-green-500/60 px-1 py-px text-[8px] uppercase tracking-wide text-green-500">
                <IconEye className="h-2 w-2" /> Vision
              </span>
            ) : null}
            {model.isNew ? (
              <span className="shrink-0 rounded-sm border border-green-500/60 px-1 py-px text-[8px] uppercase tracking-wide text-green-500">
                New
              </span>
            ) : null}
          </div>
          {meta ? <div className="mt-0.5 truncate text-[10px] text-neutral-600">{meta}</div> : null}
        </div>
        <button
          onClick={() => props.onOpen(model)}
          title="Details"
          className="shrink-0 rounded p-0.5 text-neutral-700 opacity-0 transition-all duration-150 hover:text-neutral-300 active:scale-90 group-hover:opacity-100"
        >
          <IconInfoCircle className="h-3.5 w-3.5" />
        </button>
      </div>
      <CardBadges comingSoon={comingSoon} recommended={recommended} tags={tags} tier={tier} />
      {comingSoon && model.availabilityNote ? (
        <p className="text-[9px] leading-relaxed text-neutral-600">{model.availabilityNote}</p>
      ) : null}
      <div
        className={`mt-auto flex gap-2 pt-1 ${downloading ? 'flex-col items-stretch' : 'items-center justify-between'}`}
      >
        <PrimaryModelAction {...props} downloading={downloading} />
        <InstalledActions {...props} downloading={downloading} />
      </div>
      <VisionSupport
        model={model}
        visible={!comingSoon && projector.missing && !downloading}
        failed={projector.failed}
        progress={props.progress}
        onDownload={props.onDownload}
      />
      {downloading && props.progress ? (
        <div className="flex w-full items-center gap-1.5">
          <div className="h-0.5 min-w-0 flex-1 overflow-hidden rounded-full bg-neutral-800">
            <div
              className="h-full w-full origin-left bg-green-500 transition-transform duration-300 ease-out motion-reduce:transition-none"
              style={{
                transform: `scaleX(${(projectProgress(props.progress).percentage ?? 0) / 100})`
              }}
            />
          </div>
          {props.renderDownloadActions(model.id, props.progress)}
        </div>
      ) : null}
    </div>
  )
}
