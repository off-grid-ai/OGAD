import { useCallback, useEffect, useRef, useState } from 'react'
import { HardDrives, Trash, ArrowsClockwise, X, Broom } from '@phosphor-icons/react'
import { cn } from '@renderer/lib/utils'
import { modelKindLabel } from '@renderer/lib/model-kind-labels'
import { companionDownloadLabel } from '@renderer/lib/download-label'
import {
  modelSettingsTabForKind,
  openModelSettingsPanel,
  supportsModelSettings
} from '@renderer/lib/model-settings-panel'
import { CacheCleanupControl } from './CacheCleanupControl'
import { formatStorageBytes } from './storage-format'
import { formatTransferSpeed } from '@offgrid/sync'
import { projectProgress } from '@offgrid/ui'
import { downloadTimeRemaining } from '@renderer/lib/download-progress'
import {
  desktopModelControl,
  type DesktopModelControlProjection
} from '@renderer/lib/model-control-application'
import { modelControlSurfaceForKind } from '@offgrid/models'
import {
  useModelDownloadProgress,
  type ModelDownloadProgressEvent
} from '@renderer/hooks/useModelDownloadProgress'

interface ModelDiskEntry {
  id: string
  name: string
  kind?: string
  bytes: number
  /** Legacy storage projection. Active identity comes from Shared model control. */
  active?: boolean
}
interface StorageInfo {
  dir: string
  totalBytes: number
  freeBytes: number
  models: ModelDiskEntry[]
  orphans: { name: string; bytes: number }[]
}
interface DownloadEntry {
  modelId: string
  percent?: number
  status?: 'queued' | 'downloading' | 'completed' | 'failed' | 'cancelled'
  currentFile?: string
  downloadedMB?: string
  totalMB?: string
  downloadedBytes?: number
  totalBytes?: number
  bytesPerSecond?: number
  error?: string
}
interface DownloadRecoveryHealth {
  status: 'healthy' | 'degraded'
  error?: string
}
interface OrphanCleanupResult {
  success: boolean
  count: number
  freedBytes: number
  retainedBytes: number
  failures: Array<{ name: string; bytes: number; error: string }>
}
interface ModelActionNotice {
  type: 'confirmation' | 'error'
  message: string
  modelId?: string
  kind?: string
}

// Group order for the by-type storage layout. Display labels come from the shared
// model-kind-labels source (single source of truth with the Models screen).
const KIND_ORDER = ['text', 'vision', 'image', 'voice', 'transcription', 'other']

/** Disk usage for downloaded models, orphan cleanup, and a download manager
 *  (active / failed / interrupted downloads with retry + cancel). */
export function StoragePanel(): React.ReactElement {
  const api = window.api
  const [info, setInfo] = useState<StorageInfo | null>(null)
  const [downloads, setDownloads] = useState<DownloadEntry[]>([])
  const [activeIds, setActiveIds] = useState<Set<string>>(new Set())
  const [storageError, setStorageError] = useState<string | null>(null)
  const [recoveryHealth, setRecoveryHealth] = useState<DownloadRecoveryHealth>({
    status: 'healthy'
  })
  const [cleanupFailure, setCleanupFailure] = useState<OrphanCleanupResult | null>(null)
  const [modelActionNotice, setModelActionNotice] = useState<ModelActionNotice | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const liveProgress = useRef(new Map<string, DownloadEntry>())

  const applyModelControlProjection = useCallback(
    (projection: DesktopModelControlProjection): void =>
      setActiveIds(new Set(projection.activeIds)),
    []
  )

  const refresh = useCallback(async () => {
    try {
      const s = await api.getStorageInfo()
      if (s) setInfo(s as StorageInfo)
      setStorageError(null)
    } catch (error) {
      setStorageError(
        error instanceof Error ? error.message : 'Your model library could not be read.'
      )
    }
    try {
      applyModelControlProjection(await desktopModelControl.project())
    } catch {
      // Never keep a stale active identity when the canonical projection is unavailable.
      setActiveIds(new Set())
    }
    try {
      const [d, health] = await Promise.all([api.listDownloads(), api.getDownloadRecoveryHealth()])
      if (Array.isArray(d)) {
        const registry = (d as DownloadEntry[]).map((entry) => ({
          ...entry,
          ...liveProgress.current.get(entry.modelId)
        }))
        const known = new Set(registry.map((entry) => entry.modelId))
        setDownloads([
          ...registry,
          ...Array.from(liveProgress.current.values()).filter((entry) => !known.has(entry.modelId))
        ])
      }
      setRecoveryHealth(
        health && (health.status === 'healthy' || health.status === 'degraded')
          ? (health as DownloadRecoveryHealth)
          : { status: 'degraded', error: 'Download recovery status is unavailable.' }
      )
    } catch (error) {
      setRecoveryHealth({
        status: 'degraded',
        error: error instanceof Error ? error.message : 'Download recovery status is unavailable.'
      })
    }
  }, [api, applyModelControlProjection])

  useEffect(() => {
    refresh()
    const t = setInterval(refresh, 3000)
    return () => {
      clearInterval(t)
    }
  }, [refresh, api])

  useModelDownloadProgress((event: ModelDownloadProgressEvent) => {
    const progress = event as DownloadEntry
    // The live model job is authoritative. Keep its aggregate byte and rate fields instead of
    // waiting for a reduced or stale registry poll to replace them.
    liveProgress.current.set(progress.modelId, {
      ...liveProgress.current.get(progress.modelId),
      ...progress
    })
    setDownloads((current) => {
      const index = current.findIndex((item) => item.modelId === progress.modelId)
      if (index < 0) return [...current, progress]
      const next = [...current]
      next[index] = { ...current[index], ...progress }
      return next
    })
  })

  const del = async (id: string, name: string): Promise<void> => {
    if (!window.confirm(`Delete "${name}"? This removes its files from disk.`)) return
    setBusy(id)
    try {
      await api.deleteModel(id)
      await refresh()
    } finally {
      setBusy(null)
    }
  }
  // Activate a downloaded model straight from Storage. One call — the main process
  // routes by kind (chat LLM vs image/voice/STT default). The UI never branches.
  const use = async (id: string, kind?: string, overrideMemory = false): Promise<void> => {
    setBusy(id)
    try {
      const surface = modelControlSurfaceForKind(kind ?? '')
      const result = await desktopModelControl.execute({
        type: 'activate',
        modelId: id,
        ...(surface ? { surface } : {}),
        ...(overrideMemory ? { overrideMemory: true } : {})
      })
      if (result.status === 'confirmation_required') {
        setModelActionNotice({
          type: 'confirmation',
          message: result.message,
          modelId: id,
          kind
        })
        return
      }
      if (result.status === 'failed') {
        setModelActionNotice({ type: 'error', message: result.error })
        return
      }
      applyModelControlProjection(result.projection)
      setModelActionNotice(null)
      await refresh()
    } catch (error) {
      setModelActionNotice({
        type: 'error',
        message: error instanceof Error ? error.message : 'The model could not be activated.'
      })
    } finally {
      setBusy(null)
    }
  }
  const cleanOrphans = async (): Promise<void> => {
    setBusy('orphans')
    try {
      const result = (await api.deleteOrphans()) as OrphanCleanupResult
      setCleanupFailure(result.success ? null : result)
      await refresh()
    } catch (error) {
      setCleanupFailure({
        success: false,
        count: 0,
        freedBytes: 0,
        retainedBytes: 0,
        failures: [
          {
            name: 'cleanup',
            bytes: 0,
            error: error instanceof Error ? error.message : 'Unused files could not be removed.'
          }
        ]
      })
    } finally {
      setBusy(null)
    }
  }
  const retry = async (id: string): Promise<void> => {
    setBusy(id)
    try {
      await api.retryDownload(id)
      await refresh()
    } finally {
      setBusy(null)
    }
  }
  const cancel = async (id: string): Promise<void> => {
    setBusy(id)
    try {
      const result = await desktopModelControl.execute({ type: 'cancel-download', modelId: id })
      if (result.status === 'failed') {
        setModelActionNotice({ type: 'error', message: result.error })
        return
      }
      setModelActionNotice(null)
      await refresh()
    } catch (error) {
      setModelActionNotice({
        type: 'error',
        message: error instanceof Error ? error.message : 'The download could not be cancelled.'
      })
    } finally {
      setBusy(null)
    }
  }
  const clearOne = async (id: string): Promise<void> => {
    setBusy(id)
    try {
      await api.clearDownload(id)
      await refresh()
    } finally {
      setBusy(null)
    }
  }
  const clearAllIncomplete = async (): Promise<void> => {
    setBusy('clear-dl')
    try {
      await api.clearDownloads()
      await refresh()
    } finally {
      setBusy(null)
    }
  }
  const openModelSettings = (kind?: string): void => {
    openModelSettingsPanel(modelSettingsTabForKind(kind))
  }
  const active = downloads.filter((d) => d.status === 'downloading' || d.status === 'queued')
  const runningCount = active.filter((d) => d.status === 'downloading').length
  const queuedCount = active.filter((d) => d.status === 'queued').length
  const incomplete = downloads.filter((d) => d.status === 'failed' || d.status === 'cancelled')
  const orphanBytes = (info?.orphans ?? []).reduce((s, o) => s + o.bytes, 0)
  const usedFrac =
    info && info.totalBytes + info.freeBytes > 0
      ? info.totalBytes / (info.totalBytes + info.freeBytes)
      : 0

  return (
    <div className="rounded-xl border border-neutral-800 bg-neutral-900/40 font-mono">
      <div className="flex items-center justify-between border-b border-neutral-800/60 px-4 py-3">
        <div className="flex items-center gap-2 text-[10px] font-medium uppercase tracking-widest text-neutral-500">
          <HardDrives className="h-3.5 w-3.5" /> Storage
        </div>
        <button
          onClick={refresh}
          className="flex items-center gap-1.5 text-[11px] text-neutral-500 transition-colors hover:text-white"
        >
          <ArrowsClockwise className="h-3 w-3" /> Refresh
        </button>
      </div>

      {storageError && (
        <div role="alert" className="border-b border-red-900/60 px-4 py-2 text-[11px] text-red-400">
          <div>Your model library could not be read.</div>
          <div className="mt-0.5 text-[10px] text-neutral-500">{storageError}</div>
          <button type="button" onClick={refresh} className="mt-1 underline hover:text-red-300">
            Retry
          </button>
        </div>
      )}

      {recoveryHealth.status === 'degraded' && (
        <div
          role="status"
          className="border-b border-red-900/60 px-4 py-2 text-[11px] text-red-400"
        >
          Current downloads can continue, but interrupted downloads cannot resume after restart.
          <div className="mt-0.5 text-[10px] text-neutral-500">{recoveryHealth.error}</div>
        </div>
      )}

      {cleanupFailure && (
        <div role="alert" className="border-b border-red-900/60 px-4 py-2 text-[11px] text-red-400">
          {cleanupFailure.failures.map((failure) => failure.name).join(', ')} could not be removed.
          {cleanupFailure.retainedBytes > 0
            ? ` ${formatStorageBytes(cleanupFailure.retainedBytes)} remains.`
            : ''}
        </div>
      )}

      {modelActionNotice && (
        <div role="alert" className="border-b border-red-900/60 px-4 py-2 text-[11px] text-red-400">
          <div>{modelActionNotice.message}</div>
          {modelActionNotice.type === 'confirmation' && modelActionNotice.modelId && (
            <div className="mt-1 flex gap-3">
              <button
                type="button"
                onClick={() => use(modelActionNotice.modelId!, modelActionNotice.kind, true)}
                className="underline hover:text-red-300"
              >
                Load anyway
              </button>
              <button
                type="button"
                onClick={() => setModelActionNotice(null)}
                className="underline hover:text-neutral-300"
              >
                Keep current model
              </button>
            </div>
          )}
        </div>
      )}

      <div className="px-4 py-2">
        <div className="mb-1 flex items-center justify-between">
          <span className="text-[11px] text-neutral-400">
            {info ? `${formatStorageBytes(info.totalBytes)} used by models` : 'Reading…'}
          </span>
          {info && (
            <span className="text-[10px] text-neutral-600">
              {formatStorageBytes(info.freeBytes)} free
            </span>
          )}
        </div>
        <div className="h-1 w-full overflow-hidden rounded-full bg-neutral-800">
          <div
            className="h-full rounded-full bg-green-500"
            style={{ width: `${Math.min(100, Math.round(usedFrac * 100))}%` }}
          />
        </div>
      </div>

      {/* Active + interrupted downloads */}
      {(active.length > 0 || incomplete.length > 0) && (
        <div className="border-t border-neutral-800/40 px-4 py-2">
          <div className="mb-1 flex items-center justify-between">
            <span className="text-[10px] uppercase tracking-widest text-neutral-600">
              Downloads
            </span>
            {active.length > 0 && (
              <span className="text-[10px] text-neutral-600">
                {runningCount} running · {queuedCount} queued
              </span>
            )}
            {incomplete.length > 0 && (
              <button
                onClick={clearAllIncomplete}
                disabled={busy === 'clear-dl'}
                className="text-[10px] text-neutral-500 transition-colors hover:text-white disabled:opacity-50"
              >
                {busy === 'clear-dl' ? 'Clearing…' : `Clear ${incomplete.length} interrupted`}
              </button>
            )}
          </div>
          {active.map((d) => {
            const progress = projectProgress(d)
            const timeRemaining = downloadTimeRemaining(progress)
            return (
              <div key={d.modelId} className="flex items-center gap-3 py-1.5">
                <div className="min-w-0 flex-1">
                  <div className="truncate font-mono text-[11px] text-neutral-300">
                    {d.modelId}
                    {companionDownloadLabel(d.currentFile) && (
                      // A companion-only fetch (e.g. adding a vision projector to a model
                      // already on disk) — say so, or it reads as a full re-download.
                      <span className="ml-1.5 rounded-sm border border-emerald-300/40 px-1 py-px text-[9px] uppercase tracking-wide text-emerald-300">
                        {companionDownloadLabel(d.currentFile)} only
                      </span>
                    )}
                  </div>
                  {d.status === 'queued' ? (
                    <div className="mt-0.5 text-[10px] text-neutral-500">Queued</div>
                  ) : (
                    <div className="mt-1 h-1 w-full overflow-hidden rounded-full bg-neutral-800">
                      <div
                        className="h-full w-full origin-left rounded-full bg-green-500 transition-transform duration-300 ease-out motion-reduce:transition-none"
                        style={{ transform: `scaleX(${(progress.percentage ?? 0) / 100})` }}
                      />
                    </div>
                  )}
                  {d.status === 'downloading' ? (
                    <div className="mt-1 text-[10px] tabular-nums text-neutral-500">
                      {progress.totalBytes !== undefined
                        ? `${formatStorageBytes(progress.currentBytes)} of ${formatStorageBytes(progress.totalBytes)}`
                        : 'Total size unavailable'}
                      {progress.bytesPerSecond !== undefined
                        ? ` · ${formatTransferSpeed(progress.bytesPerSecond)}`
                        : ''}
                      {timeRemaining ? ` · ${timeRemaining}` : ''}
                    </div>
                  ) : null}
                </div>
                {d.status === 'downloading' && (
                  <span className="font-mono text-[10px] text-neutral-500">
                    {progress.determinate
                      ? `${Math.round(progress.percentage ?? 0)}%`
                      : 'Downloading'}
                  </span>
                )}
                <button
                  onClick={() => cancel(d.modelId)}
                  className="rounded-md p-1 text-neutral-500 hover:text-white"
                  aria-label={`Cancel ${d.modelId}`}
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            )
          })}
          {incomplete.map((d) => (
            <div key={d.modelId} className="flex items-center gap-3 py-1.5">
              <div className="min-w-0 flex-1">
                <div className="truncate font-mono text-[11px] text-neutral-300">{d.modelId}</div>
                <div className="truncate text-[10px] text-neutral-500">{d.error ?? d.status}</div>
              </div>
              <button
                onClick={() => retry(d.modelId)}
                disabled={busy === d.modelId}
                className="rounded-md border border-neutral-700 px-2 py-1 text-[10px] text-neutral-300 hover:border-green-500/60 hover:text-white disabled:opacity-50"
              >
                {busy === d.modelId ? '…' : 'Retry'}
              </button>
              <button
                onClick={() => clearOne(d.modelId)}
                disabled={busy === d.modelId}
                aria-label="Dismiss"
                title="Dismiss and delete the partial file"
                className="rounded-md p-1 text-neutral-500 transition-colors hover:text-red-400 disabled:opacity-50"
              >
                <Trash className="h-3.5 w-3.5" />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Installed models — grouped by type, each group a width-filling grid so
          the type and the active model per type are easy to spot. */}
      <div className="border-t border-neutral-800/40 p-3">
        {info && info.models.length === 0 ? (
          <div className="px-1 py-3 text-center text-xs text-neutral-600">
            No models installed yet.
          </div>
        ) : (
          <div className="space-y-3">
            {KIND_ORDER.filter((k) =>
              (info?.models ?? []).some((m) => (m.kind || 'other') === k)
            ).map((kind) => {
              const group = (info?.models ?? []).filter((m) => (m.kind || 'other') === kind)
              const activeModel = group.find((model) => activeIds.has(model.id))
              return (
                <div key={kind}>
                  <div className="mb-1.5 flex items-center gap-2">
                    <span className="text-[9px] font-medium uppercase tracking-widest text-neutral-500">
                      {modelKindLabel(kind)}
                    </span>
                    <span className="text-[9px] text-neutral-700">{group.length}</span>
                    {activeModel && (
                      <span className="flex items-center gap-1 text-[9px] text-green-500">
                        <span className="h-1 w-1 rounded-full bg-green-500" /> {activeModel.name}{' '}
                        active
                      </span>
                    )}
                    <div className="h-px flex-1 bg-neutral-800/50" />
                  </div>
                  <div className="grid grid-cols-2 gap-1.5 md:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5">
                    {group.map((m) => {
                      const modelActive = activeIds.has(m.id)
                      // Every model type has an "active" pick — activate any non-active one.
                      const activatable = !modelActive
                      return (
                        <div
                          key={m.id}
                          className={`group flex h-7 items-center gap-2 rounded border px-2.5 transition-colors duration-150 hover:border-neutral-700 ${modelActive ? 'border-green-500/50 bg-green-500/5' : 'border-neutral-800/60 bg-neutral-900/30'}`}
                        >
                          {modelActive && supportsModelSettings(m.kind) && (
                            <div className="h-1.5 w-1.5 shrink-0 rounded-full bg-green-500" />
                          )}
                          <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-neutral-200">
                            {m.name}
                          </span>
                          {/* Hover actions: activate (text/vision) + delete. Size shows when idle. */}
                          {activatable && (
                            <button
                              onClick={() => use(m.id, m.kind)}
                              disabled={busy === m.id}
                              className="hidden shrink-0 rounded border border-neutral-700 px-1.5 text-[9px] leading-4 text-neutral-300 transition-all duration-150 hover:border-green-500 hover:text-emerald-500 active:scale-95 disabled:opacity-40 group-hover:block"
                            >
                              {busy === m.id ? '…' : 'Use'}
                            </button>
                          )}
                          <span
                            className={`shrink-0 font-mono text-[10px] text-neutral-500 tabular-nums ${activatable ? 'group-hover:hidden' : ''}`}
                          >
                            {formatStorageBytes(m.bytes)}
                          </span>
                          {modelActive && (
                            <button
                              type="button"
                              onClick={() => openModelSettings(m.kind)}
                              aria-label={`Settings for ${m.name}`}
                              title="Open settings for the active model"
                              className="shrink-0 rounded border border-neutral-700 px-1.5 text-[9px] leading-4 text-neutral-400 transition-all duration-150 hover:border-green-500 hover:text-emerald-500 active:scale-95"
                            >
                              Settings
                            </button>
                          )}
                          <button
                            onClick={() => del(m.id, m.name)}
                            disabled={busy === m.id || modelActive}
                            aria-label={`Delete ${m.name}`}
                            title={modelActive ? 'Deactivate before deleting' : 'Delete'}
                            className="shrink-0 rounded p-0.5 text-neutral-700 transition-all duration-150 hover:text-red-400 active:scale-90 disabled:opacity-30 group-hover:text-neutral-500"
                          >
                            <Trash className="h-3 w-3" />
                          </button>
                        </div>
                      )
                    })}
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>

      {info && info.orphans.length > 0 && (
        <div className="flex items-center justify-between border-t border-neutral-800/60 px-4 py-2.5">
          <span className="text-[11px] text-neutral-500">
            {info.orphans.length} unused file{info.orphans.length > 1 ? 's' : ''} ·{' '}
            {formatStorageBytes(orphanBytes)}
          </span>
          <button
            onClick={cleanOrphans}
            disabled={busy === 'orphans'}
            className={cn(
              'flex items-center gap-1.5 rounded-md border border-neutral-700 px-2.5 py-1 text-[10px] text-neutral-300',
              'transition-colors hover:border-green-500/60 hover:text-white disabled:opacity-50'
            )}
          >
            <Broom className="h-3 w-3" /> {busy === 'orphans' ? 'Cleaning…' : 'Clean up'}
          </button>
        </div>
      )}

      <CacheCleanupControl />
    </div>
  )
}
