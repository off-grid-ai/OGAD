import { IconPlayerPause, IconPlayerPlay, IconX } from '@tabler/icons-react'
import type { DownloadCardProgress } from './model-card-types'

export function ModelDownloadActions({
  modelId,
  progress,
  changing,
  onChange
}: {
  modelId: string
  progress: DownloadCardProgress
  changing: boolean
  onChange: (id: string, type: 'pause-download' | 'resume-download' | 'cancel-download') => void
}): React.JSX.Element {
  const controllable = Boolean(progress.downloadId && progress.status !== 'preparing')
  if (!controllable) return <div className="flex shrink-0" />
  const paused = progress.status === 'paused'
  return (
    <div className="flex shrink-0 items-center gap-0.5">
      <button
        disabled={changing}
        onClick={() => onChange(modelId, paused ? 'resume-download' : 'pause-download')}
        aria-label={paused ? 'Resume' : 'Pause'}
        title={paused ? 'Resume download' : 'Pause download'}
        className="rounded p-1 text-neutral-500 transition-colors duration-150 hover:bg-neutral-800 hover:text-neutral-200 active:scale-90 disabled:opacity-40"
      >
        {paused ? (
          <IconPlayerPlay className="h-3.5 w-3.5" />
        ) : (
          <IconPlayerPause className="h-3.5 w-3.5" />
        )}
      </button>
      <button
        disabled={changing}
        onClick={() => onChange(modelId, 'cancel-download')}
        aria-label="Cancel"
        title="Cancel download"
        className="rounded p-1 text-neutral-500 transition-colors duration-150 hover:bg-neutral-800 hover:text-red-400 active:scale-90 disabled:opacity-40"
      >
        <IconX className="h-3.5 w-3.5" />
      </button>
    </div>
  )
}
