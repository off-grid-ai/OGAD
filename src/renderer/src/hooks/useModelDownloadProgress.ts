import { useEffect, useRef } from 'react'
import type { ModelsEvent } from '@offgrid/application'

type PublicDownloadEvent = Extract<ModelsEvent, { type: 'download' }>['event']

export interface ModelDownloadProgressEvent {
  downloadId: string
  modelId: string
  percent?: number
  status?: PublicDownloadEvent['status']
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

function projectDownloadEvent(
  event: PublicDownloadEvent,
  bytesPerSecond?: number
): ModelDownloadProgressEvent {
  const bytesDownloaded = 'bytesDownloaded' in event ? event.bytesDownloaded : undefined
  const totalBytes = 'totalBytes' in event ? event.totalBytes : undefined
  return {
    downloadId: event.downloadId,
    modelId: event.modelId,
    status: event.status,
    currentFile: event.fileName,
    ...(bytesDownloaded === undefined ? {} : { bytesDownloaded }),
    ...(totalBytes === undefined ? {} : { totalBytes }),
    ...(bytesPerSecond === undefined ? {} : { bytesPerSecond }),
    ...(bytesDownloaded === undefined
      ? {}
      : { downloadedMB: (bytesDownloaded / 1024 / 1024).toFixed(1) }),
    ...(totalBytes === undefined ? {} : { totalMB: (totalBytes / 1024 / 1024).toFixed(1) }),
    ...(totalBytes && bytesDownloaded !== undefined
      ? { percent: Math.min(100, Math.round((bytesDownloaded / totalBytes) * 100)) }
      : {}),
    ...('reason' in event ? { error: event.reason } : {})
  }
}

const VISIBLE_PROGRESS_INTERVAL_MS = 2_000

function isTerminal(event: ModelDownloadProgressEvent): boolean {
  return (
    event.status === 'completed' ||
    event.status === 'failed' ||
    event.status === 'cancelled' ||
    event.status === 'interrupted'
  )
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
    const rateSamples = new Map<
      string,
      { readonly at: number; readonly bytesDownloaded: number; readonly fileName: string }
    >()
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
      const now = Date.now()
      const previousSample = rateSamples.get(incoming.downloadId)
      const elapsedMs = previousSample ? now - previousSample.at : 0
      const byteDelta =
        'bytesDownloaded' in incoming && previousSample
          ? incoming.bytesDownloaded - previousSample.bytesDownloaded
          : 0
      const bytesPerSecond =
        previousSample?.fileName === incoming.fileName && elapsedMs > 0 && byteDelta >= 0
          ? (byteDelta * 1_000) / elapsedMs
          : undefined
      if ('bytesDownloaded' in incoming) {
        rateSamples.set(incoming.downloadId, {
          at: now,
          bytesDownloaded: incoming.bytesDownloaded,
          fileName: incoming.fileName
        })
      }
      const event = projectDownloadEvent(incoming, bytesPerSecond)
      if (isTerminal(event)) {
        rateSamples.delete(incoming.downloadId)
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
      rateSamples.clear()
      off()
    }
  }, [enabled])
}
