import { WarningCircle } from '@phosphor-icons/react'
import { useEffect, useState } from 'react'
import type { EmbeddingRebuildStatus } from '../../../shared/embedding-rebuild-contract'
import { LoadingDots } from './ui/loading-dots'
import { Button } from './ui/button'

export function EmbeddingRebuildNotice(): React.JSX.Element | null {
  const [status, setStatus] = useState<EmbeddingRebuildStatus | null>(null)
  const [cancelling, setCancelling] = useState(false)
  const [cancelError, setCancelError] = useState<string | null>(null)
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

  useEffect(() => {
    if (status?.phase !== 'restored') return
    const timer = window.setTimeout(
      () => setStatus((current) => (current?.phase === 'restored' ? null : current)),
      10_000
    )
    return () => window.clearTimeout(timer)
  }, [status?.phase])

  const cancel = async (): Promise<void> => {
    setCancelling(true)
    setCancelError(null)
    try {
      const result = await window.api.cancelEmbeddingRebuild()
      if (!result.canceled) setCancelError(result.error ?? 'The rebuild has already finished.')
    } catch (error) {
      setCancelError(error instanceof Error ? error.message : 'Could not cancel the rebuild.')
    } finally {
      setCancelling(false)
    }
  }

  if (!status || status.phase === 'idle' || status.phase === 'done') return null
  if (status.phase === 'restored')
    return (
      <div
        role="status"
        aria-live="polite"
        className="absolute inset-x-0 top-0 z-40 flex items-center justify-center gap-2 bg-emerald-950/90 px-4 py-1.5 font-mono text-[11px] text-emerald-200"
      >
        <span>Previous embedding model and search index restored.</span>
        <Button
          variant="ghost"
          size="xs"
          onClick={() => setStatus(null)}
          className="h-5 text-emerald-100 hover:bg-emerald-800/60"
        >
          Dismiss
        </Button>
      </div>
    )
  if (status.phase === 'error')
    return (
      <div
        role="status"
        aria-live="assertive"
        className="absolute inset-x-0 top-0 z-40 flex items-center justify-center gap-2 bg-red-950/90 px-4 py-1.5 font-mono text-[11px] text-red-200"
      >
        <WarningCircle size={13} aria-hidden />
        <span>Search index rebuild failed: {status.error ?? 'Unknown error'}</span>
        <Button
          variant="ghost"
          size="xs"
          onClick={() => setStatus(null)}
          className="h-5 text-red-100 hover:bg-red-800/60"
        >
          Dismiss
        </Button>
      </div>
    )
  const model = status.model.split('/').pop() ?? 'embedding model'
  return (
    <div
      role="status"
      aria-live="polite"
      className="absolute inset-x-0 top-0 z-40 flex items-center justify-center gap-2 bg-neutral-900/90 px-4 py-1.5 font-mono text-[11px] text-neutral-300"
    >
      <span>
        {status.phase === 'preparing'
          ? `Preparing ${model} search index`
          : `Indexing search and project knowledge with ${model}${status.total ? `: ${status.done} of ${status.total}` : ''}`}
      </span>
      <LoadingDots size="small" />
      <Button
        variant="outline"
        size="xs"
        disabled={cancelling}
        onClick={() => void cancel()}
        className="h-5 border-neutral-600 bg-neutral-800 text-neutral-100 hover:bg-neutral-700"
      >
        {cancelling ? 'Restoring...' : 'Cancel and restore'}
      </Button>
      {cancelError && <span className="text-red-300">{cancelError}</span>}
    </div>
  )
}
