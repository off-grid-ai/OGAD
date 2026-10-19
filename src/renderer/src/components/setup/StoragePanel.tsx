import { Button } from '@offgrid/operator-ui/operator/coss/button'
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  HardDrives,
  Trash,
  ArrowsClockwise,
  X,
  Broom,
  FolderOpen,
  FolderPlus,
  Cube,
  ArrowClockwise,
  CircleNotch,
  GearSix
} from '@phosphor-icons/react'
import { AnimatePresence, motion } from 'motion/react'
import { Meter, MeterIndicator, MeterTrack } from '@offgrid/operator-ui/operator/coss/meter'
import {
  Progress,
  ProgressIndicator,
  ProgressTrack
} from '@offgrid/operator-ui/operator/coss/progress'
import { AnimatedNumber } from '@offgrid/operator-ui/operator/motion/animated-number'
import { TextShimmer } from '@offgrid/operator-ui/operator/text-shimmer'
import { Empty, EmptyDescription, EmptyMedia } from '@offgrid/operator-ui/operator/coss/empty'
import { cn } from '@renderer/lib/utils'
import { modelKindLabel } from '@renderer/lib/model-kind-labels'
import { companionDownloadLabel } from '@renderer/lib/download-label'
import {
  modelSettingsTabForKind,
  openModelSettingsPanel,
  supportsModelSettings
} from '@renderer/lib/model-settings-panel'
import { CacheCleanupControl } from './CacheCleanupControl'
import { GlyphSwap, IconTip } from '../IconTip'
import { Section } from '@offgrid/operator-ui/operator/experience'
import { formatStorageBytes } from './storage-format'
import { formatTransferSpeed } from '@offgrid/sync'
import { projectProgress } from '@offgrid/ui'
import { downloadTimeRemaining } from '@renderer/lib/download-progress'
import {
  useModelDownloadProgress,
  type ModelDownloadProgressEvent
} from '@renderer/hooks/useModelDownloadProgress'

interface ModelDiskEntry {
  id: string
  name: string
  kind?: string
  bytes: number
  active: boolean
}
interface StorageInfo {
  dir: string
  unavailable?: string
  totalBytes: number
  freeBytes: number
  models: ModelDiskEntry[]
  orphans: { name: string; bytes: number }[]
}
interface DownloadEntry {
  modelId: string
  /** The name main resolved for `modelId`. Rows show this, never the id. */
  modelName: string
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

// Group order for the by-type storage layout. Display labels come from the shared
// model-kind-labels source (single source of truth with the Models screen).
const KIND_ORDER = ['text', 'vision', 'computer_use', 'image', 'voice', 'transcription', 'other']

/** Disk usage for downloaded models, orphan cleanup, and a download manager
 *  (active / failed / interrupted downloads with retry + cancel). */
export function StoragePanel(): React.ReactElement {
  const api = window.api
  const [info, setInfo] = useState<StorageInfo | null>(null)
  const [downloads, setDownloads] = useState<DownloadEntry[]>([])
  const [busy, setBusy] = useState<string | null>(null)
  const [directoryError, setDirectoryError] = useState<string | null>(null)
  const [pendingDirectory, setPendingDirectory] = useState<string | null>(null)
  const [movedFiles, setMovedFiles] = useState(false)
  const [unknownEntriesLeft, setUnknownEntriesLeft] = useState(0)
  const [scanFolders, setScanFolders] = useState<string[]>([])
  const liveProgress = useRef(new Map<string, DownloadEntry>())

  const refresh = useCallback(async () => {
    try {
      const [s, d] = await Promise.all([api.getStorageInfo(), api.listDownloads()])
      if (s) setInfo(s as StorageInfo)
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
    } catch {
      /* keep last */
    }
  }, [api])

  useEffect(() => {
    refresh()
    Promise.resolve()
      .then(() => api.getModelScanFolders())
      .then((folders: string[] | undefined) => setScanFolders(folders ?? []))
      .catch(() => {})
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
  const chooseDirectory = async (): Promise<void> => {
    setBusy('directory')
    setDirectoryError(null)
    try {
      const result = await api.chooseModelDirectory()
      if (result.error) setDirectoryError(result.error)
      else if (result.restartRequired && result.directory) {
        setPendingDirectory(result.directory)
        setMovedFiles(Boolean(result.moved))
        setUnknownEntriesLeft(result.unknownEntriesLeft ?? 0)
        if (result.moved) await refresh()
        if (result.warning) setDirectoryError(result.warning)
      }
    } catch (error) {
      setDirectoryError(error instanceof Error ? error.message : 'Cannot use this folder.')
    } finally {
      setBusy(null)
    }
  }
  const addScanFolder = async (): Promise<void> => {
    setBusy('scan')
    setDirectoryError(null)
    try {
      const result = await api.addModelScanFolder()
      if (result.error) setDirectoryError(result.error)
      else if (result.folders) setScanFolders(result.folders)
    } catch (error) {
      setDirectoryError(error instanceof Error ? error.message : 'Cannot read this folder.')
    } finally {
      setBusy(null)
    }
  }
  const removeScanFolder = async (directory: string): Promise<void> => {
    setBusy('scan')
    try {
      setScanFolders(await api.removeModelScanFolder(directory))
    } catch (error) {
      setDirectoryError(error instanceof Error ? error.message : 'Cannot remove this folder.')
    } finally {
      setBusy(null)
    }
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
    <Section
      label={
        <span className="flex items-center gap-2">
          <HardDrives className="h-3.5 w-3.5" /> Storage
        </span>
      }
      actions={
        <IconTip label="Refresh">
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label="Refresh"
            onClick={refresh}
            className="text-neutral-500 hover:text-white"
          >
            <ArrowsClockwise className="h-3.5 w-3.5" />
          </Button>
        </IconTip>
      }
      className="font-mono"
    >
      <div className="rounded-xl border border-neutral-800 bg-neutral-900/40">
        <div className="px-4 py-2">
          <div className="mb-1 flex items-center justify-between">
            <span className="text-[11px] text-neutral-400">
              {info ? (
                `${formatStorageBytes(info.totalBytes)} used by models`
              ) : (
                <TextShimmer as="span">Reading…</TextShimmer>
              )}
            </span>
            {info && (
              <span className="text-[10px] text-neutral-600">
                {formatStorageBytes(info.freeBytes)} free
              </span>
            )}
          </div>
          <Meter aria-label="Disk used by models" value={Math.min(100, Math.round(usedFrac * 100))}>
            <MeterTrack className="h-1 rounded-full bg-neutral-800">
              <MeterIndicator className="rounded-full bg-green-500" />
            </MeterTrack>
          </Meter>
        </div>

        <div className="flex flex-wrap items-center gap-3 border-t border-neutral-800/40 px-4 py-3">
          <div className="min-w-0 flex-1">
            <div className="text-[10px] uppercase tracking-widest text-neutral-500">
              Model folder
            </div>
            <div className="mt-1 break-all text-[11px] text-neutral-300" title={info?.dir}>
              {info?.dir ?? 'Reading...'}
            </div>
            <div className="mt-1 text-[10px] text-neutral-500">
              Downloads for all model types go here. Compatible chat and vision GGUF models from LM
              Studio and Ollama also appear in Models. External files stay where they are.
            </div>
            {info?.unavailable && (
              <div role="alert" className="mt-2 text-[11px] text-red-400">
                {info.unavailable} Model downloads are paused.
              </div>
            )}
            {pendingDirectory && (
              <div className="mt-2 text-[11px] text-neutral-300">
                New folder: <span className="break-all">{pendingDirectory}</span>.
                {movedFiles
                  ? ` The new folder is active. Old copies are removed after the next restart if verified. ${unknownEntriesLeft} unknown entries were left in place.`
                  : ' Restart to use it. Existing files stay in the current folder.'}
              </div>
            )}
            {directoryError && (
              <div role="alert" className="mt-2 text-[11px] text-red-400">
                {directoryError}
              </div>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <IconTip label={busy === 'directory' ? 'Choosing...' : 'Choose folder'}>
              <Button
                size="icon-sm"
                variant="outline"
                type="button"
                aria-label={busy === 'directory' ? 'Choosing...' : 'Choose folder'}
                aria-busy={busy === 'directory' || undefined}
                onClick={chooseDirectory}
                disabled={busy === 'directory' || active.length > 0}
              >
                <FolderOpen />
              </Button>
            </IconTip>
            {pendingDirectory && (
              <Button size="sm" type="button" onClick={() => api.restartForModelDirectory()}>
                Restart now
              </Button>
            )}
          </div>
        </div>

        <div className="border-t border-neutral-800/40 px-4 py-3">
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="text-[10px] uppercase tracking-widest text-neutral-500">
                Other model folders
              </div>
              <div className="mt-1 text-[10px] text-neutral-500">
                Add a folder to reuse compatible chat, image, voice, and transcription models. Files
                stay in their current folder.
              </div>
            </div>
            <IconTip label="Add folder">
              <Button
                size="icon-sm"
                variant="outline"
                type="button"
                aria-label="Add folder"
                onClick={addScanFolder}
                disabled={busy === 'scan'}
                className="shrink-0"
              >
                <FolderPlus />
              </Button>
            </IconTip>
          </div>
          {scanFolders.length > 0 && (
            <div className="mt-2 space-y-1">
              {scanFolders.map((directory) => (
                <div
                  key={directory}
                  className="flex items-center gap-2 text-[11px] text-neutral-300"
                >
                  <span className="min-w-0 flex-1 break-all">{directory}</span>
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    type="button"
                    onClick={() => removeScanFolder(directory)}
                    disabled={busy === 'scan'}
                    aria-label={`Remove ${directory}`}
                    className="text-neutral-500 hover:text-red-400"
                  >
                    <X />
                  </Button>
                </div>
              ))}
            </div>
          )}
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
                <IconTip
                  label={
                    busy === 'clear-dl' ? 'Clearing…' : `Clear ${incomplete.length} interrupted`
                  }
                >
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    aria-label={
                      busy === 'clear-dl' ? 'Clearing…' : `Clear ${incomplete.length} interrupted`
                    }
                    aria-busy={busy === 'clear-dl' || undefined}
                    onClick={clearAllIncomplete}
                    disabled={busy === 'clear-dl'}
                    className="text-neutral-500 hover:text-white disabled:opacity-50"
                  >
                    <Broom className="h-3.5 w-3.5" />
                  </Button>
                </IconTip>
              )}
            </div>
            <AnimatePresence initial={false}>
              {active.map((d) => {
                const progress = projectProgress(d)
                const timeRemaining = downloadTimeRemaining(progress)
                return (
                  <motion.div
                    key={d.modelId}
                    layout
                    initial={{ opacity: 0, y: 6 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0 }}
                    transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
                    className="flex items-center gap-3 py-1.5"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[11px] text-neutral-300">
                        {d.modelName}
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
                        <Progress
                          aria-label={`${d.modelName} download progress`}
                          value={progress.percentage ?? 0}
                          className="mt-1"
                        >
                          <ProgressTrack className="h-1 bg-neutral-800">
                            <ProgressIndicator className="rounded-full bg-green-500 duration-300 ease-out motion-reduce:transition-none" />
                          </ProgressTrack>
                        </Progress>
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
                        {progress.determinate ? (
                          <>
                            <AnimatedNumber value={Math.round(progress.percentage ?? 0)} />%
                          </>
                        ) : (
                          <TextShimmer as="span">Downloading</TextShimmer>
                        )}
                      </span>
                    )}
                    <button
                      onClick={() => cancel(d.modelId)}
                      className="rounded-md p-1 text-neutral-500 hover:text-white"
                      aria-label={`Cancel ${d.modelName}`}
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </motion.div>
                )
              })}
            </AnimatePresence>
            <AnimatePresence initial={false}>
              {incomplete.map((d) => (
                <motion.div
                  key={d.modelId}
                  layout
                  initial={{ opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
                  className="flex items-center gap-3 py-1.5"
                >
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[11px] text-neutral-300">{d.modelName}</div>
                    <div className="truncate text-[10px] text-neutral-500">
                      {d.error ?? d.status}
                    </div>
                  </div>
                  <IconTip label="Retry">
                    <Button
                      size="icon-xs"
                      variant="ghost"
                      aria-label="Retry"
                      aria-busy={busy === d.modelId || undefined}
                      onClick={() => retry(d.modelId)}
                      disabled={busy === d.modelId}
                      className="text-neutral-300 hover:text-white disabled:opacity-50"
                    >
                      <GlyphSwap glyphKey={busy === d.modelId ? 'busy' : 'idle'}>
                        {busy === d.modelId ? (
                          <CircleNotch className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <ArrowClockwise className="h-3.5 w-3.5" />
                        )}
                      </GlyphSwap>
                    </Button>
                  </IconTip>
                  <button
                    onClick={() => clearOne(d.modelId)}
                    disabled={busy === d.modelId}
                    aria-label="Dismiss"
                    title="Dismiss and delete the partial file"
                    className="rounded-md p-1 text-neutral-500 transition-colors hover:text-red-400 disabled:opacity-50"
                  >
                    <Trash className="h-3.5 w-3.5" />
                  </button>
                </motion.div>
              ))}
            </AnimatePresence>
          </div>
        )}

        {/* Installed models — grouped by type, each group a width-filling grid so
          the type and the active model per type are easy to spot. */}
        <div className="border-t border-neutral-800/40 p-3">
          {info && info.models.length === 0 ? (
            <Empty className="px-1 py-3 md:py-3">
              <EmptyMedia variant="icon">
                <Cube className="text-neutral-600" />
              </EmptyMedia>
              <EmptyDescription className="text-xs text-neutral-600">
                No models installed yet.
              </EmptyDescription>
            </Empty>
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
                          <span className="h-1 w-1 rounded-full bg-green-500" /> {active.name}{' '}
                          active
                        </span>
                      )}
                      <div className="h-px flex-1 bg-neutral-800/50" />
                    </div>
                    <div className="grid grid-cols-2 gap-1.5 md:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5">
                      <AnimatePresence initial={false}>
                        {group.map((m) => {
                          // Every model type has an "active" pick — activate any non-active one.
                          const activatable = !m.active
                          return (
                            <motion.div
                              key={m.id}
                              layout
                              initial={{ opacity: 0, y: 6 }}
                              animate={{ opacity: 1, y: 0 }}
                              exit={{ opacity: 0 }}
                              transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
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
                                <IconTip label="Open settings for the active model">
                                  <button
                                    type="button"
                                    onClick={() => openModelSettings(m.kind)}
                                    aria-label={`Settings for ${m.name}`}
                                    className="shrink-0 rounded p-0.5 text-neutral-400 transition-all duration-150 hover:text-emerald-500 active:scale-95"
                                  >
                                    <GearSix className="h-3 w-3" />
                                  </button>
                                </IconTip>
                              )}
                              {!m.id.startsWith('external:') && (
                                <button
                                  onClick={() => del(m.id, m.name)}
                                  disabled={busy === m.id || m.active}
                                  aria-label={`Delete ${m.name}`}
                                  title={m.active ? 'Deactivate before deleting' : 'Delete'}
                                  className="shrink-0 rounded p-0.5 text-neutral-700 transition-all duration-150 hover:text-red-400 active:scale-90 disabled:opacity-30 group-hover:text-neutral-500"
                                >
                                  <Trash className="h-3 w-3" />
                                </button>
                              )}
                            </motion.div>
                          )
                        })}
                      </AnimatePresence>
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
            <IconTip label={busy === 'orphans' ? 'Cleaning…' : 'Clean up'}>
              <Button
                size="icon-xs"
                variant="outline"
                aria-label={busy === 'orphans' ? 'Cleaning…' : 'Clean up'}
                aria-busy={busy === 'orphans' || undefined}
                onClick={cleanOrphans}
                disabled={busy === 'orphans'}
                className={cn(
                  'border-neutral-700 text-neutral-300',
                  'hover:border-green-500/60 hover:text-white disabled:opacity-50'
                )}
              >
                <GlyphSwap glyphKey={busy === 'orphans' ? 'busy' : 'idle'}>
                  {busy === 'orphans' ? (
                    <CircleNotch className="h-3 w-3 animate-spin" />
                  ) : (
                    <Broom className="h-3 w-3" />
                  )}
                </GlyphSwap>
              </Button>
            </IconTip>
          </div>
        )}

        <CacheCleanupControl />
      </div>
    </Section>
  )
}
