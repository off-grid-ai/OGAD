import { useEffect, useRef } from 'react'

export interface ModelDownloadProgressEvent {
  modelId: string
  percent?: number
  status?: 'queued' | 'downloading' | 'completed' | 'failed' | 'cancelled'
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

const VISIBLE_PROGRESS_INTERVAL_MS = 2_000

function isTerminal(event: ModelDownloadProgressEvent): boolean {
  return event.status === 'completed' || event.status === 'failed' || event.status === 'cancelled'
}

/** Coalesce noisy IPC progress independently per model. The first progress
 * event is visible immediately; later progress is trailing-edge limited. A
 * terminal event cancels pending work so stale progress cannot replace it. */
export function useModelDownloadProgress(
  onProgress: (event: ModelDownloadProgressEvent) => void,
  enabled = true
): void {
  const handler = useRef(onProgress)
  useEffect(() => {
    handler.current = onProgress
  }, [onProgress])

  useEffect(() => {
    if (!enabled) return
    const pending = new Map<string, ModelDownloadProgressEvent>()
    const lastVisibleAt = new Map<string, number>()
    const timers = new Map<string, ReturnType<typeof setTimeout>>()

    const clearModelTimer = (modelId: string): void => {
      const timer = timers.get(modelId)
      if (timer) clearTimeout(timer)
      timers.delete(modelId)
    }

    const emitPending = (modelId: string): void => {
      timers.delete(modelId)
      const event = pending.get(modelId)
      if (!event) return
      pending.delete(modelId)
      lastVisibleAt.set(modelId, Date.now())
      handler.current(event)
    }

    const off = window.api.onModelProgress((incoming) => {
      const event = incoming as ModelDownloadProgressEvent
      if (isTerminal(event)) {
        clearModelTimer(event.modelId)
        pending.delete(event.modelId)
        lastVisibleAt.delete(event.modelId)
        handler.current(event)
        return
      }

      const previous = pending.get(event.modelId)
      pending.set(event.modelId, { ...previous, ...event })
      const elapsed = Date.now() - (lastVisibleAt.get(event.modelId) ?? Number.NEGATIVE_INFINITY)
      if (elapsed >= VISIBLE_PROGRESS_INTERVAL_MS) {
        clearModelTimer(event.modelId)
        emitPending(event.modelId)
        return
      }
      if (!timers.has(event.modelId)) {
        timers.set(
          event.modelId,
          setTimeout(() => emitPending(event.modelId), VISIBLE_PROGRESS_INTERVAL_MS - elapsed)
        )
      }
    })

    return () => {
      for (const timer of timers.values()) clearTimeout(timer)
      timers.clear()
      pending.clear()
      off()
    }
  }, [enabled])
}
