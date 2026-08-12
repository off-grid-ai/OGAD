import { useCallback, useEffect, useState } from 'react'
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

interface ModelDiskEntry {
  id: string
  name: string
  kind?: string
  bytes: number
  active: boolean
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
  error?: string
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
  const [busy, setBusy] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      const [s, d] = await Promise.all([api.getStorageInfo(), api.listDownloads()])
      if (s) setInfo(s as StorageInfo)
      if (Array.isArray(d)) setDownloads(d as DownloadEntry[])
    } catch {
      /* keep last */
    }
  }, [api])

  useEffect(() => {
    refresh()
    const t = setInterval(refresh, 3000)
    const off = (
      api as unknown as { onModelProgress?: (cb: () => void) => () => void }
    ).onModelProgress?.(refresh)
    return () => {
      clearInterval(t)
      off?.()
    }
  }, [refresh, api])

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
  const use = async (id: string): Promise<void> => {
    setBusy(id)
    try {
      await api.activateModel(id)
      await refresh()
    } finally {
      setBusy(null)
    }
  }
  const cleanOrphans = async (): Promise<void> => {
    setBusy('orphans')
    try {
      await api.deleteOrphans()
      await refresh()
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
      await api.cancelModelDownload(id)
      await refresh()
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
          {active.map((d) => (
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
                      className="h-full rounded-full bg-green-500 transition-all"
                      style={{ width: `${d.percent ?? 0}%` }}
                    />
                  </div>
                )}
              </div>
              {d.status === 'downloading' && (
                <span className="font-mono text-[10px] text-neutral-500">{d.percent ?? 0}%</span>
              )}
              <button
                onClick={() => cancel(d.modelId)}
                className="rounded-md p-1 text-neutral-500 hover:text-white"
                aria-label={`Cancel ${d.modelId}`}
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          ))}
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
              const active = group.find((m) => m.active)
              return (
                <div key={kind}>
                  <div className="mb-1.5 flex items-center gap-2">
                    <span className="text-[9px] font-medium uppercase tracking-widest text-neutral-500">
                      {modelKindLabel(kind)}
                    </span>
                    <span className="text-[9px] text-neutral-700">{group.length}</span>
                    {active && (
                      <span className="flex items-center gap-1 text-[9px] text-green-500">
                        <span className="h-1 w-1 rounded-full bg-green-500" /> {active.name} active
                      </span>
                    )}
                    <div className="h-px flex-1 bg-neutral-800/50" />
                  </div>
                  <div className="grid grid-cols-2 gap-1.5 md:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5">
                    {group.map((m) => {
                      // Every model type has an "active" pick — activate any non-active one.
                      const activatable = !m.active
                      return (
                        <div
                          key={m.id}
                          className={`group flex h-7 items-center gap-2 rounded border px-2.5 transition-colors duration-150 hover:border-neutral-700 ${m.active ? 'border-green-500/50 bg-green-500/5' : 'border-neutral-800/60 bg-neutral-900/30'}`}
                        >
                          {m.active && supportsModelSettings(m.kind) && (
                            <div className="h-1.5 w-1.5 shrink-0 rounded-full bg-green-500" />
                          )}
                          <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-neutral-200">
                            {m.name}
                          </span>
                          {/* Hover actions: activate (text/vision) + delete. Size shows when idle. */}
                          {activatable && (
                            <button
                              onClick={() => use(m.id)}
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
                          {m.active && (
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
                            disabled={busy === m.id || m.active}
                            aria-label={`Delete ${m.name}`}
                            title={m.active ? 'Deactivate before deleting' : 'Delete'}
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
