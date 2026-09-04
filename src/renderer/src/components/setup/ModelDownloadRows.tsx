import { Trash, X } from '@phosphor-icons/react'
import { formatTransferSpeed, type PublicDownloadInfo } from '@offgrid/application'
import { projectProgress } from '@offgrid/ui'
import { companionDownloadLabel } from '@renderer/lib/download-label'
import { downloadTimeRemaining } from '@renderer/lib/download-progress'
import { formatStorageBytes } from './storage-format'

export interface DownloadEntry {
  downloadId: string
  modelId: string
  percent?: number
  status?: PublicDownloadInfo['status']
  currentFile?: string
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
  onCancel(modelId: string): void
  onRetry(modelId: string): void
  onClear(modelId: string): void
  onClearAll(): void
}

function ActiveDownloadRow({
  download,
  onCancel
}: {
  download: DownloadEntry
  onCancel(modelId: string): void
}): React.ReactElement {
  const progress = projectProgress(download)
  const timeRemaining = downloadTimeRemaining(progress)
  const companion = companionDownloadLabel(download.currentFile)
  return (
    <div className="flex items-center gap-3 py-1.5">
      <div className="min-w-0 flex-1">
        <div className="truncate font-mono text-[11px] text-neutral-300">
          {download.modelId}
          {companion && (
            <span className="ml-1.5 rounded-sm border border-emerald-300/40 px-1 py-px text-[9px] uppercase tracking-wide text-emerald-300">
              {companion} only
            </span>
          )}
        </div>
        {download.status === 'queued' ? (
          <div className="mt-0.5 text-[10px] text-neutral-500">Queued</div>
        ) : (
          <div className="mt-1 h-1 w-full overflow-hidden rounded-full bg-neutral-800">
            <div
              className="h-full w-full origin-left rounded-full bg-green-500 transition-transform duration-300 ease-out motion-reduce:transition-none"
              style={{ transform: `scaleX(${(progress.percentage ?? 0) / 100})` }}
            />
          </div>
        )}
        {download.status === 'downloading' && (
          <div className="mt-1 text-[10px] tabular-nums text-neutral-500">
            {progress.totalBytes === undefined
              ? 'Total size unavailable'
              : `${formatStorageBytes(progress.currentBytes)} of ${formatStorageBytes(progress.totalBytes)}`}
            {progress.bytesPerSecond === undefined
              ? ''
              : ` · ${formatTransferSpeed(progress.bytesPerSecond)}`}
            {timeRemaining ? ` · ${timeRemaining}` : ''}
          </div>
        )}
      </div>
      {download.status === 'downloading' && (
        <span className="font-mono text-[10px] text-neutral-500">
          {progress.determinate ? `${Math.round(progress.percentage ?? 0)}%` : 'Downloading'}
        </span>
      )}
      <button
        onClick={() => onCancel(download.modelId)}
        className="rounded-md p-1 text-neutral-500 hover:text-white"
        aria-label={`Cancel ${download.modelId}`}
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  )
}

export function ModelDownloadRows({
  active,
  incomplete,
  busy,
  onCancel,
  onRetry,
  onClear,
  onClearAll
}: ModelDownloadRowsProps): React.ReactElement | null {
  if (active.length === 0 && incomplete.length === 0) return null
  const runningCount = active.filter((download) => download.status === 'downloading').length
  const queuedCount = active.filter((download) => download.status === 'queued').length
  return (
    <div className="border-t border-neutral-800/40 px-4 py-2">
      <div className="mb-1 flex items-center justify-between">
        <span className="text-[10px] uppercase tracking-widest text-neutral-600">Downloads</span>
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
      {active.map((download) => (
        <ActiveDownloadRow key={download.modelId} download={download} onCancel={onCancel} />
      ))}
      {incomplete.map((download) => (
        <div key={download.modelId} className="flex items-center gap-3 py-1.5">
          <div className="min-w-0 flex-1">
            <div className="truncate font-mono text-[11px] text-neutral-300">
              {download.modelId}
            </div>
            <div className="truncate text-[10px] text-neutral-500">
              {download.error ?? download.status}
            </div>
          </div>
          <button
            onClick={() => onRetry(download.modelId)}
            disabled={busy === download.modelId}
            className="rounded-md border border-neutral-700 px-2 py-1 text-[10px] text-neutral-300 hover:border-green-500/60 hover:text-white disabled:opacity-50"
          >
            {busy === download.modelId ? '…' : 'Retry'}
          </button>
          <button
            onClick={() => onClear(download.modelId)}
            disabled={busy === download.modelId}
            aria-label="Dismiss"
            title="Dismiss and delete the partial file"
            className="rounded-md p-1 text-neutral-500 transition-colors hover:text-red-400 disabled:opacity-50"
          >
            <Trash className="h-3.5 w-3.5" />
          </button>
        </div>
      ))}
    </div>
  )
}
