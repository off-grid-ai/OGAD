import { useEffect, useState } from 'react'
import { DownloadSimple, Pause, Play, ArrowClockwise, CheckCircle } from '@phosphor-icons/react'
import { projectProgress } from '@offgrid/ui'
import { Button } from '../ui/button'
import type { PerformancePackStatus } from '../../../../shared/performance-pack'
import { currentPlatform } from '@renderer/lib/device'
import { formatStorageBytes } from './storage-format'

interface PerformancePackPanelProps {
  onSkip?: () => void
  showUnavailable?: boolean
}

const GPU_COMPONENTS = [
  { name: 'Chat and vision', detail: 'NVIDIA chat engine' },
  { name: 'Image generation', detail: 'NVIDIA image engine' },
  { name: 'Transcription', detail: 'NVIDIA speech-to-text engine' },
  { name: 'Computer Use', detail: 'NVIDIA grounding and decision engines' }
] as const

export function PerformancePackPanel({ onSkip, showUnavailable = false }: PerformancePackPanelProps): React.ReactElement | null {
  const [status, setStatus] = useState<PerformancePackStatus | null>(null)

  useEffect(() => {
    const pack = window.api.performancePack
    if (typeof pack?.status !== 'function') return
    void pack.status().then(setStatus).catch(() => {})
    return pack.onChanged?.(setStatus)
  }, [])

  if (!status) return showUnavailable ? <p role="status" className="text-sm text-neutral-500">Checking GPU components...</p> : null
  if (status.phase === 'not-needed' || status.phase === 'unavailable') {
    if (!showUnavailable) return null
    const message = currentPlatform() === 'darwin'
      ? 'Metal support is included on macOS. No extra GPU download is needed.'
      : status.phase === 'not-needed'
        ? 'No NVIDIA driver was found. The CUDA download is only for devices with an NVIDIA GPU.'
        : 'No optional GPU download is available in this build.'
    return <p className="text-sm text-neutral-500">{message}</p>
  }

  const progress = projectProgress({
    downloadedBytes: status.downloadedBytes,
    totalBytes: status.bytes
  })
  const installed = status.phase === 'installed'
  const downloading = status.phase === 'downloading'
  const action = downloading ? window.api.performancePack.pause : window.api.performancePack.start

  return (
    <section className="rounded-md border border-neutral-800 bg-neutral-900/40 p-4 font-mono">
      <div className="flex items-start gap-3">
        <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-md border border-neutral-800 bg-neutral-800/60">
          {installed ? <CheckCircle className="h-5 w-5 text-green-500" /> : <DownloadSimple className="h-5 w-5 text-green-500" />}
        </div>
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-medium text-white">Use your NVIDIA GPU</h3>
          <p className="mt-1 text-xs leading-5 text-neutral-400">
            One download of {formatStorageBytes(status.bytes)} adds GPU support for the model types below.
            You can use the app during the download or skip this step.
          </p>
          {installed ? (
            <p className="mt-2 text-xs text-green-500">
              {status.restartRequired ? 'Installed. Restart the app to use it.' : 'Installed and ready.'}
            </p>
          ) : null}
          {status.error ? <p className="mt-2 text-xs text-red-400">{status.error}</p> : null}
        </div>
      </div>
      <div className="mt-4 divide-y divide-neutral-800 rounded-md border border-neutral-800 bg-neutral-950/40 px-3">
        {GPU_COMPONENTS.map((component) => (
          <div key={component.name} className="flex items-center justify-between gap-3 py-2.5">
            <div className="min-w-0">
              <p className="text-xs text-neutral-200">{component.name}</p>
              <p className="text-[11px] text-neutral-500">{component.detail}</p>
            </div>
            <span className={`shrink-0 text-[11px] ${installed ? 'text-green-500' : 'text-neutral-500'}`}>
              {installed ? 'Ready' : 'Included'}
            </span>
          </div>
        ))}
      </div>
      <p className="mt-2 text-[11px] text-neutral-500">
        Voice replies and search use separate GPU settings.
      </p>
      {status.downloadedBytes > 0 && !installed ? (
        <div className="mt-4">
          <div className="mb-1 flex justify-between text-[11px] text-neutral-400">
            <span>{status.phase === 'paused' ? 'Paused' : 'Downloading'}</span>
            <span>{formatStorageBytes(status.downloadedBytes)} / {formatStorageBytes(status.bytes)}</span>
          </div>
          <div className="h-1.5 overflow-hidden rounded-sm bg-neutral-800" role="progressbar" aria-label="NVIDIA GPU download" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress.percentage ?? 0}>
            <div className="h-full bg-green-500" style={{ width: `${progress.percentage ?? 0}%` }} />
          </div>
        </div>
      ) : null}
      <div className="mt-4 flex flex-wrap gap-2">
        {installed && status.restartRequired ? (
          <Button size="sm" onClick={() => void window.api.performancePack.restart()}>
            <ArrowClockwise className="h-4 w-4" /> Restart app
          </Button>
        ) : !installed ? (
          <Button size="sm" onClick={() => void action().then(setStatus)}>
            {downloading ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
            {downloading ? 'Pause' : status.phase === 'paused' ? 'Resume' : status.phase === 'failed' ? 'Try again' : 'Download'}
          </Button>
        ) : null}
        {onSkip ? (
          <Button size="sm" variant="outline" onClick={onSkip}>Skip for now</Button>
        ) : null}
      </div>
    </section>
  )
}
