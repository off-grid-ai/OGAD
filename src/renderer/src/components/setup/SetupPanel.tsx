import { useCallback, useEffect, useId, useRef, useState } from 'react'
import {
  MagicWand,
  CheckCircle,
  WarningCircle,
  ChatCircle,
  Image as ImageIcon,
  VideoCamera,
  SpeakerHigh,
  Microphone,
  DownloadSimple,
  DesktopTower,
  Devices
} from '@phosphor-icons/react'
import { cn } from '@renderer/lib/utils'
import { deviceNoun } from '@renderer/lib/device'
import { HealthPanel } from './HealthPanel'
import { formatTransferSpeed } from '@offgrid/sync'
import { projectProgress } from '@offgrid/ui'
import { totalDownloadGb } from '../../../../main/models/setup-logic'
import { formatStorageBytes } from './storage-format'

import type {
  RecMode as Mode,
  SetupPlan,
  SetupItemKind as ItemKind,
  SetupProgress
} from '../../../../main/setup'

const MODES: { id: Mode; label: string; hint: string }[] = [
  {
    id: 'conservative',
    label: 'Conservative',
    hint: 'Lightest - small, fast, low memory (skips image and video models)'
  },
  {
    id: 'balanced',
    label: 'Balanced',
    hint: 'Recommended - capable vision model within a safe share of RAM'
  },
  { id: 'extreme', label: 'Extreme', hint: 'Largest model and context your RAM allows' }
]

const KIND_ICON: Record<
  ItemKind,
  React.ComponentType<{ className?: string; weight?: 'fill' | 'regular' }>
> = {
  chat: ChatCircle,
  transcription: Microphone,
  voice: SpeakerHigh,
  image: ImageIcon,
  video: VideoCamera
}

interface SetupPanelProps {
  onConfigured?: () => void // called once auto-configure succeeds (e.g. to dismiss a gate)
  hideHealth?: boolean // hide the embedded health panel (first-run gate)
}

function reportSetupFailure(operation: string, error: unknown): void {
  console.error(`[setup] ${operation} failed`, error)
}

/** The reusable setup surface: pick a resource mode, see exactly which model it'll
 *  install, then one-click Configure. Used on the first-run gate and in Settings. */
export function SetupPanel({ onConfigured, hideHealth }: SetupPanelProps): React.ReactElement {
  const api = window.api
  const selectionId = useId()
  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState<SetupProgress | null>(null)
  const [mode, setMode] = useState<Mode>('balanced')
  const [loadingPlan, setLoadingPlan] = useState(false)
  const [plan, setPlan] = useState<SetupPlan | null>(null)
  const [selectedKinds, setSelectedKinds] = useState<Partial<Record<ItemKind, boolean>>>({
    chat: true
  })
  const selectedItems = plan?.items.filter((item) => selectedKinds[item.kind]) ?? []
  const downloadGb = totalDownloadGb(selectedItems)
  const firedConfigured = useRef(false)
  const downloadProgress = progress?.phase === 'download' ? projectProgress(progress) : null

  const loadPlan = useCallback(
    async (m: Mode) => {
      try {
        const p = (await api.setupPlan(m)) as SetupPlan | null
        setPlan(p ?? null)
      } catch {
        setPlan(null)
      }
    },
    [api]
  )

  // Initial: read the saved mode, then preview its full plan.
  useEffect(() => {
    const initialize = async (): Promise<void> => {
      let m: Mode = 'balanced'
      try {
        const s = (await api.getLlmSettings()) as { performanceMode?: Mode } | undefined
        if (s?.performanceMode) m = s.performanceMode
      } catch {
        /* default */
      }
      setMode(m)
      await loadPlan(m)
    }
    initialize().catch((error: unknown) => reportSetupFailure('initialization', error))
  }, [api, loadPlan])

  // Progress stream for the whole lifetime.
  useEffect(() => {
    const off = (
      api as unknown as { onSetupProgress?: (cb: (p: SetupProgress) => void) => () => void }
    ).onSetupProgress?.((p) => {
      setProgress(p)
      if (p.phase === 'done' || p.phase === 'error') setRunning(false)
      if (p.phase === 'done' && !firedConfigured.current) {
        firedConfigured.current = true
        onConfigured?.()
      }
    })
    return () => off?.()
  }, [api, onConfigured])

  const pickMode = async (m: Mode): Promise<void> => {
    if (loadingPlan || m === mode) return
    setLoadingPlan(true)
    try {
      // This control previews downloads; it must not update or reload the live LLM.
      setMode(m)
      await loadPlan(m)
    } catch (error) {
      reportSetupFailure('resource-mode preview', error)
    } finally {
      setLoadingPlan(false)
    }
  }

  const configure = async (): Promise<void> => {
    if (running || loadingPlan || !selectedItems.length) return
    firedConfigured.current = false
    setRunning(true)
    setProgress({ phase: 'select', message: 'Checking selected local models...' })
    try {
      const result = await api.autoConfigure(
        selectedItems.map((item) => item.id),
        mode
      )
      if (!result.success) {
        setProgress({ phase: 'error', message: result.error ?? 'Setup failed.' })
      }
      await loadPlan(mode)
    } catch (e) {
      setProgress({ phase: 'error', message: e instanceof Error ? e.message : 'Setup failed.' })
    } finally {
      setRunning(false)
    }
  }

  const cancel = (): void => {
    const id = progress?.modelId
    if (id) {
      api
        .cancelModelDownload(id)
        .catch((error: unknown) => reportSetupFailure('model-download cancellation', error))
    }
  }

  const done = progress?.phase === 'done'
  const errored = progress?.phase === 'error'
  let progressTextClass = 'text-neutral-400'
  if (done) progressTextClass = 'text-green-500'
  else if (errored) progressTextClass = 'text-neutral-300'

  return (
    <div className="space-y-4 font-mono">
      <div className="rounded-xl border border-neutral-800 bg-neutral-900/60 p-4">
        <div className="flex items-start gap-3">
          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-neutral-800 bg-neutral-800/60">
            <MagicWand className="h-5 w-5 text-green-500" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium text-white">Configure it for me</div>
            <div className="text-xs text-neutral-500">
              Pick how much of your {deviceNoun()} to use. Off Grid AI Desktop shows each model
              before it downloads anything.
            </div>
          </div>
          <button
            onClick={configure}
            disabled={running || loadingPlan || !selectedItems.length}
            className={cn(
              'shrink-0 whitespace-nowrap rounded-lg px-4 py-2 text-xs font-medium transition-colors',
              'bg-green-600 text-white hover:bg-green-500 disabled:cursor-not-allowed disabled:opacity-60'
            )}
          >
            {running ? 'Setting up...' : 'Set up selected'}
          </button>
        </div>

        <div className="mt-4 grid gap-px overflow-hidden rounded-lg border border-neutral-800 bg-neutral-800 lg:grid-cols-2">
          <div className="bg-neutral-950/70 p-3">
            <div className="flex items-center gap-2 text-[10px] uppercase tracking-widest text-neutral-400">
              <DesktopTower className="h-4 w-4 text-green-500" />
              Local and remote
            </div>
            <p className="mt-2 text-[11px] leading-5 text-neutral-500">
              Installed models can handle Chat, images, videos, transcription, voice, and Computer
              Use on this {deviceNoun()}. A saved model server is an optional Chat source.
            </p>
          </div>
          <div className="bg-neutral-950/70 p-3">
            <div className="flex items-center gap-2 text-[10px] uppercase tracking-widest text-neutral-400">
              <Devices className="h-4 w-4 text-green-500" />
              Control from Mobile
            </div>
            <p className="mt-2 text-[11px] leading-5 text-neutral-500">
              Pair Off Grid AI Mobile through Personal Mesh. Choose this Desktop by name to see and
              switch its active models. Server API keys stay on this Desktop.
            </p>
          </div>
        </div>

        {/* Resource-use selector (Conservative / Balanced / Extreme) */}
        <div className="mt-4">
          <div className="mb-1.5 text-[10px] uppercase tracking-widest text-neutral-600">
            Resource use
          </div>
          <div className="flex overflow-hidden rounded-lg border border-neutral-800">
            {MODES.map((m) => (
              <button
                key={m.id}
                onClick={() => {
                  void pickMode(m.id)
                }}
                disabled={loadingPlan || running}
                aria-pressed={mode === m.id}
                className={cn(
                  'flex-1 px-2 py-1.5 text-xs transition-colors',
                  mode === m.id
                    ? 'bg-green-500/15 text-green-500'
                    : 'text-neutral-400 hover:bg-neutral-800/60'
                )}
              >
                {m.label}
              </button>
            ))}
          </div>
          <div className="mt-1.5 text-[11px] text-neutral-500">
            {MODES.find((m) => m.id === mode)?.hint}
          </div>
        </div>

        {/* Exactly which models it will set up — the full baseline, no surprises */}
        {plan && (
          <div className="mt-3">
            <div className="mb-1.5 flex items-center justify-between text-[10px] uppercase tracking-widest text-neutral-600">
              <span>Choose local models</span>
              <span className="normal-case tracking-normal text-neutral-500">
                {downloadGb > 0
                  ? `~${downloadGb.toFixed(1)} GB to download`
                  : selectedItems.length
                    ? 'selected models installed'
                    : 'no models selected'}
                {' · sized for your '}
                {plan.ramGb} GB {deviceNoun()}
              </span>
            </div>
            <ul className="divide-y divide-neutral-800/70 overflow-hidden rounded-lg border border-neutral-800 bg-neutral-950/40">
              {plan.items.map((it) => {
                const Icon = KIND_ICON[it.kind]
                return (
                  <li key={it.id} className="flex items-center gap-2 px-2.5 py-1.5">
                    <input
                      type="checkbox"
                      id={`${selectionId}-${it.kind}`}
                      aria-label={`Set up ${it.name} for ${it.capability}`}
                      checked={!!selectedKinds[it.kind]}
                      disabled={running || loadingPlan}
                      onChange={(event) =>
                        setSelectedKinds((current) => ({
                          ...current,
                          [it.kind]: event.target.checked
                        }))
                      }
                      className="h-4 w-4 shrink-0 accent-primary"
                    />
                    <Icon className="h-4 w-4 shrink-0 text-green-500" weight="regular" />
                    <div className="min-w-0 flex-1">
                      <label
                        htmlFor={`${selectionId}-${it.kind}`}
                        className="block cursor-pointer truncate text-xs text-white"
                      >
                        {it.name}
                      </label>
                      <div className="text-[10px] uppercase tracking-wider text-neutral-600">
                        {it.capability}
                      </div>
                      {it.files && (
                        <details className="text-[10px] text-neutral-500">
                          <summary className="w-fit cursor-pointer transition-colors hover:text-foreground">
                            Required files ({it.files.length})
                          </summary>
                          {it.files.map((file) => (
                            <div key={file.name} className="break-all">
                              {file.name} ({formatStorageBytes(file.sizeBytes ?? 0)})
                            </div>
                          ))}
                        </details>
                      )}
                    </div>
                    {it.installed ? (
                      <span className="flex shrink-0 items-center gap-1 text-[10px] text-green-500">
                        <CheckCircle weight="fill" className="h-3.5 w-3.5" /> installed
                      </span>
                    ) : (
                      <span className="flex shrink-0 items-center gap-1 text-[10px] text-neutral-500">
                        <DownloadSimple className="h-3.5 w-3.5" />{' '}
                        {it.sizeGb ? `${it.sizeGb.toFixed(1)} GB` : 'size unknown'}
                      </span>
                    )}
                  </li>
                )
              })}
            </ul>
            {plan.videoNote && (
              <div className="mt-1.5 text-[11px] text-neutral-500">{plan.videoNote}</div>
            )}
            <div className="mt-1.5 text-[11px] text-neutral-600">
              Only checked models download. Each video model includes all required files. Your saved
              active choices stay unchanged.
            </div>
            <div className="mt-2 rounded-md border border-neutral-800 bg-neutral-900/40 px-2.5 py-1.5 text-[11px] text-neutral-500">
              For solid reasoning and tool use,{' '}
              <span className="text-neutral-300">Gemma 4 E4B</span> is the recommended minimum (4B,
              ~6 GB - fine on a 16 GB {deviceNoun()}). Smaller 2B models are lighter and add vision,
              but are noticeably weaker at reasoning.
            </div>
          </div>
        )}

        {/* Progress / result */}
        {progress && (
          <div className="mt-4">
            <div className="flex items-center gap-2 text-xs">
              {done && <CheckCircle weight="fill" className="h-4 w-4 text-green-500" />}
              {errored && <WarningCircle weight="fill" className="h-4 w-4 text-neutral-300" />}
              <span className={progressTextClass}>{progress.message}</span>
            </div>
            {running && progress.phase === 'download' && (
              <div className="mt-2">
                <div className="flex items-center gap-2">
                  <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-neutral-800">
                    <div
                      className="h-full rounded-full bg-green-500 transition-all"
                      style={{ width: `${downloadProgress?.percentage ?? 0}%` }}
                    />
                  </div>
                  <button
                    onClick={cancel}
                    className="shrink-0 rounded-md border border-neutral-700 px-2 py-0.5 text-[10px] text-neutral-400 transition-colors hover:border-red-500/60 hover:text-red-400"
                  >
                    Cancel
                  </button>
                </div>
                <div className="mt-1 text-[10px] text-neutral-600">
                  {downloadProgress?.determinate
                    ? `${Math.round(downloadProgress.percentage ?? 0)}%`
                    : 'Downloading'}
                  {downloadProgress?.totalBytes !== undefined
                    ? ` · ${formatStorageBytes(downloadProgress.currentBytes)} / ${formatStorageBytes(downloadProgress.totalBytes)}`
                    : ''}
                  {downloadProgress?.bytesPerSecond !== undefined
                    ? ` · ${formatTransferSpeed(downloadProgress.bytesPerSecond)}`
                    : ''}
                </div>
              </div>
            )}
            {running && progress.phase !== 'download' && (
              <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-neutral-800">
                <div className="h-full w-1/3 animate-pulse rounded-full bg-green-500/60" />
              </div>
            )}
          </div>
        )}
      </div>

      {!hideHealth && <HealthPanel />}
    </div>
  )
}
