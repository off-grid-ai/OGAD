import { Pause, Play, Trash, X } from '@phosphor-icons/react'
import { type PublicDownloadInfo } from '@offgrid/application'
import { projectProgress } from '@offgrid/ui'
import { companionDownloadLabel } from '@renderer/lib/download-label'
import { downloadProgressSummary } from '@renderer/lib/download-progress'

export interface DownloadEntry {
  downloadId: string
  modelId: string
  percent?: number
  status?: PublicDownloadInfo['status']
  currentFile?: string
  currentFileRole?: PublicDownloadInfo['currentFileRole']
  downloadedMB?: string
  totalMB?: string
  downloadedBytes?: number
  totalBytes?: number
  bytesPerSecond?: number
  error?: string
}

interface ModelDownloadRowsProps {
  active: DownloadEntry[]
  incomplete: DownloadEntry[]
  busy: string | null
  retryBusy: ReadonlySet<string>
  cancelBusy: ReadonlySet<string>
  onCancel(downloadId: string): void
  onPause(downloadId: string): void
  onResume(downloadId: string): void
  onRetry(downloadId: string): void
  onClear(downloadId: string): void
  onClearAll(): void
}

const PAUSABLE_OR_PAUSED = new Set<DownloadEntry['status']>(['downloading', 'queued', 'paused'])

function ActiveDownloadRow({
  download,
  onCancel,
  onPause,
  onResume,
  busy
}: {
  download: DownloadEntry
  onCancel(downloadId: string): void
  onPause(downloadId: string): void
  onResume(downloadId: string): void
  busy: boolean
}): React.ReactElement {
  const progress = projectProgress(download)
  const summary = downloadProgressSummary(progress)
  const companion = companionDownloadLabel(download.currentFileRole)
  return (
    <div className="flex items-center gap-3 py-1.5">
      <div className="min-w-0 flex-1">
        <div className="truncate font-mono text-[11px] text-neutral-300">
          {download.modelId}
          {companion && (
            <span className="ml-1.5 rounded-sm border border-emerald-300/40 px-1 py-px text-[9px] uppercase tracking-wide text-emerald-300">
              {companion}
            </span>
          )}
        </div>
        {download.status === 'preparing' || download.status === 'queued' ? (
          <div className="mt-0.5 text-[10px] text-neutral-500">
            {download.status === 'preparing' ? 'Preparing download…' : 'Queued'}
          </div>
        ) : (
          <div className="mt-1 h-1 w-full overflow-hidden rounded-full bg-neutral-800">
            <div
              className="h-full w-full origin-left rounded-full bg-green-500 transition-transform duration-300 ease-out motion-reduce:transition-none"
              style={{ transform: `scaleX(${(progress.percentage ?? 0) / 100})` }}
            />
          </div>
        )}
        {(download.status === 'downloading' || download.status === 'paused') && (
          <div className="mt-1 text-[10px] tabular-nums text-neutral-500">
            {download.status === 'paused' ? (
              `Paused · ${summary.bytes}`
            ) : (
              <>
                {summary.bytes} · {summary.rate}
                {summary.timeRemaining ? ` · ${summary.timeRemaining}` : ''}
              </>
            )}
          </div>
        )}
      </div>
      {download.status === 'downloading' && (
        <span className="font-mono text-[10px] text-neutral-500">
          {progress.determinate ? `${Math.round(progress.percentage ?? 0)}%` : 'Downloading'}
        </span>
      )}
      {PAUSABLE_OR_PAUSED.has(download.status) && (
        <button
          disabled={busy}
          onClick={() =>
            download.status === 'paused'
              ? onResume(download.downloadId)
              : onPause(download.downloadId)
          }
          className="rounded-md p-1 text-neutral-500 hover:text-white disabled:opacity-50"
          aria-label={`${download.status === 'paused' ? 'Resume' : 'Pause'} ${download.modelId}`}
          title={download.status === 'paused' ? 'Resume download' : 'Pause download'}
        >
          {download.status === 'paused' ? (
            <Play className="h-3.5 w-3.5" />
          ) : (
            <Pause className="h-3.5 w-3.5" />
          )}
        </button>
      )}
      {download.status !== 'preparing' && (
        <button
          disabled={busy}
          onClick={() => onCancel(download.downloadId)}
          className="rounded-md p-1 text-neutral-500 hover:text-white"
          aria-label={`Cancel ${download.modelId}`}
        >
          <X className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  )
}

export function ModelDownloadRows({
  active,
  incomplete,
  busy,
  retryBusy,
  cancelBusy,
  onCancel,
  onPause,
  onResume,
  onRetry,
  onClear,
  onClearAll
}: ModelDownloadRowsProps): React.ReactElement | null {
  if (active.length === 0 && incomplete.length === 0) return null
  const runningCount = active.filter((download) => download.status === 'downloading').length
  const queuedCount = active.filter(
    (download) => download.status === 'preparing' || download.status === 'queued'
  ).length
  return (
    <div className="border-t border-neutral-800/40 px-4 py-2">
      <div className="mb-1 flex items-center gap-3">
        <span className="text-[10px] uppercase tracking-widest text-neutral-600">Downloads</span>
        <div className="ml-auto flex flex-wrap items-center justify-end gap-x-4 gap-y-1 text-right">
          {active.length > 0 && (
            <span className="text-[10px] text-neutral-600">
              {runningCount} running · {queuedCount} queued
            </span>
          )}
          {incomplete.length > 0 && (
            <button
              onClick={onClearAll}
              disabled={busy === 'clear-dl'}
              className="text-[10px] text-neutral-500 transition-colors hover:text-white disabled:opacity-50"
            >
              {busy === 'clear-dl' ? 'Clearing…' : `Clear ${incomplete.length} interrupted`}
            </button>
          )}
        </div>
      </div>
      {active.map((download) => (
        <ActiveDownloadRow
          key={download.downloadId}
          download={download}
          onCancel={onCancel}
          onPause={onPause}
          onResume={onResume}
          busy={cancelBusy.has(download.downloadId)}
        />
      ))}
      {incomplete.map((download) => {
        const companion = companionDownloadLabel(download.currentFileRole)
        return (
          <div key={download.downloadId} className="flex items-center gap-3 py-1.5">
            <div className="min-w-0 flex-1">
              <div className="truncate font-mono text-[11px] text-neutral-300">
                {download.modelId}
                {companion && (
                  <span className="ml-1.5 text-[10px] text-neutral-500">{companion}</span>
                )}
              </div>
              <div className="truncate text-[10px] text-neutral-500">
                {download.error ?? download.status}
              </div>
            </div>
            <button
              onClick={() => onRetry(download.downloadId)}
              disabled={
                busy === download.downloadId ||
                retryBusy.has(download.downloadId) ||
                cancelBusy.has(download.downloadId)
              }
              className="rounded-md border border-neutral-700 px-2 py-1 text-[10px] text-neutral-300 hover:border-green-500/60 hover:text-white disabled:opacity-50"
            >
              {busy === download.downloadId || retryBusy.has(download.downloadId) ? '…' : 'Retry'}
            </button>
            <button
              onClick={() => onClear(download.downloadId)}
              disabled={
                busy === download.downloadId ||
                retryBusy.has(download.downloadId) ||
                cancelBusy.has(download.downloadId)
              }
              aria-label="Dismiss"
              title="Dismiss and delete the partial file"
              className="rounded-md p-1 text-neutral-500 transition-colors hover:text-red-400 disabled:opacity-50"
            >
              <Trash className="h-3.5 w-3.5" />
            </button>
          </div>
        )
      })}
    </div>
  )
}
