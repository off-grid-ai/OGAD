import { WarningCircle } from '@phosphor-icons/react'
import { useEffect, useState } from 'react'
import type { EmbeddingRebuildStatus } from '../../../shared/embedding-rebuild-contract'
import { LoadingDots } from './ui/loading-dots'

export function EmbeddingRebuildNotice(): React.JSX.Element | null {
  const [status, setStatus] = useState<EmbeddingRebuildStatus | null>(null)
  useEffect(() => {
    let mounted = true
    const unsubscribe = window.api.onEmbeddingRebuildStatusChanged((next) => {
      if (mounted) setStatus(next)
    })
    void window.api
      .getEmbeddingRebuildStatus()
      .then((next) => {
        if (mounted) setStatus(next)
      })
      .catch(() => {})
    return () => {
      mounted = false
      unsubscribe()
    }
  }, [])

  if (!status || status.phase === 'idle' || status.phase === 'done') return null
  if (status.phase === 'error')
    return (
      <div
        role="status"
        aria-live="assertive"
        className="pointer-events-none absolute inset-x-0 top-0 z-40 flex items-center justify-center gap-2 bg-red-950/90 px-4 py-1.5 font-mono text-[11px] text-red-200"
      >
        <WarningCircle size={13} aria-hidden />
        <span>Search index rebuild failed: {status.error ?? 'Unknown error'}</span>
      </div>
    )
  const model = status.model.split('/').pop() ?? 'embedding model'
  return (
    <div
      role="status"
      aria-live="polite"
      className="pointer-events-none absolute inset-x-0 top-0 z-40 flex items-center justify-center gap-2 bg-neutral-900/90 px-4 py-1.5 font-mono text-[11px] text-neutral-300"
    >
      <span>
        {status.phase === 'preparing'
          ? `Preparing ${model} search index`
          : `Indexing search and project knowledge with ${model}${status.total ? `: ${status.done} of ${status.total}` : ''}`}
      </span>
      <LoadingDots size="small" />
    </div>
  )
}
