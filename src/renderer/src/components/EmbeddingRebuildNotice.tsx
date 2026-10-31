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
        className="absolute inset-x-0 top-0 z-40 flex items-center justify-center gap-2 border-b border-primary/30 bg-card/90 px-4 py-1.5 font-mono text-meta text-primary"
      >
        <span>Previous embedding model and search index restored.</span>
        <Button variant="ghost" size="xs" onClick={() => setStatus(null)} className="h-5">
          Dismiss
        </Button>
      </div>
    )
  if (status.phase === 'error')
    return (
      <div
        role="status"
        aria-live="assertive"
        className="absolute inset-x-0 top-0 z-40 flex items-center justify-center gap-2 border-b border-destructive/30 bg-card/90 px-4 py-1.5 font-mono text-meta text-destructive"
      >
        <WarningCircle size={13} aria-hidden />
        <span className="min-w-0">
          {status.error?.startsWith('Could not restore the previous index:')
            ? 'Search index could not be restored. Restart the app to retry recovery. Details are in the app log.'
            : 'Search index rebuild failed. Previous model and index restored. Try again. Details are in the app log.'}
        </span>
        <Button variant="ghost" size="xs" onClick={() => setStatus(null)} className="h-5">
          Dismiss
        </Button>
      </div>
    )
  const model = status.model.split('/').pop() ?? 'embedding model'
  return (
    <div
      role="status"
      aria-live="polite"
      aria-busy="true"
      className="absolute inset-x-0 top-0 z-40 flex items-center justify-center gap-2 border-b border-border bg-card/90 px-4 py-1.5 font-mono text-meta text-foreground/80"
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
        className="h-5 bg-secondary"
      >
        {cancelling ? 'Restoring...' : 'Cancel and restore'}
      </Button>
      {cancelError && <span className="text-destructive">{cancelError}</span>}
    </div>
  )
}
