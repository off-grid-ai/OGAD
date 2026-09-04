import { useCallback, useEffect, useRef, useState } from 'react'
import {
  MagicWand,
  CheckCircle,
  WarningCircle,
  ChatCircle,
  Image as ImageIcon,
  SpeakerHigh,
  Microphone,
  DownloadSimple,
  DesktopTower,
  Devices
} from '@phosphor-icons/react'
import { cn } from '@renderer/lib/utils'
import { deviceNoun } from '@renderer/lib/device'
import { HealthPanel } from './HealthPanel'
import { formatTransferSpeed, modelsFailureMessage } from '@offgrid/application'
import type { ModelsFailure } from '@offgrid/application'
import type { GuidedSetupResult } from '@offgrid/models'
import { projectProgress } from '@offgrid/ui'
import { formatStorageBytes } from './storage-format'
import { modelControlClient } from '@renderer/lib/model-control-client'
import { invalidateLlmSettings } from '@renderer/lib/settings-invalidation'

type Mode = 'conservative' | 'balanced' | 'extreme'

function savedMode(value: unknown): Mode {
  if (value === 'conservative' || value === 'balanced' || value === 'extreme') return value
  throw new Error('The saved resource mode could not be read.')
}

const MODES: { id: Mode; label: string; hint: string }[] = [
  {
    id: 'conservative',
    label: 'Conservative',
    hint: 'Lightest - small, fast, low memory (skips the image model)'
  },
  {
    id: 'balanced',
    label: 'Balanced',
    hint: 'Recommended - capable vision model within a safe share of RAM'
  },
  { id: 'extreme', label: 'Extreme', hint: 'Largest model and context your RAM allows' }
]

type ItemKind = 'chat' | 'transcription' | 'voice' | 'image'
const KIND_ICON: Record<
  ItemKind,
  React.ComponentType<{ className?: string; weight?: 'fill' | 'regular' }>
> = {
  chat: ChatCircle,
  transcription: Microphone,
  voice: SpeakerHigh,
  image: ImageIcon
}

interface SetupProgress {
  phase: 'select' | 'download' | 'activate' | 'start' | 'verify' | 'done' | 'error' | 'cancelled'
  message: string
  modelId?: string
  modelName?: string
  percent?: number
  downloadedMB?: string
  totalMB?: string
  downloadedBytes?: number
  totalBytes?: number
  bytesPerSecond?: number
}
interface SetupItem {
  kind: ItemKind
  capability: string
  id: string
  name: string
  sizeGb: number
  installed: boolean
  required: boolean
}
interface SetupPlan {
  mode: Mode
  ramGb: number
  items: SetupItem[]
  totalDownloadGb: number
}

interface SetupPanelProps {
  // Called once auto-configure actually reaches `ready` - the engine answered its health
  // check. NOT on the `done` progress phase, which the domain also emits for `warming_up`.
  onConfigured?: () => void
  hideHealth?: boolean // hide the embedded health panel (first-run gate)
}

function reportSetupFailure(operation: string, error: unknown): void {
  console.error(`[setup] ${operation} failed`, error)
}

/** The terminal record the run itself returned. The progress stream cannot stand in for it:
 *  the domain emits the `done` phase for a server that is still warming up as well as for one
 *  that answered, and a person cancelling is terminal but is not a failure. */
type SetupOutcome = GuidedSetupResult<ModelsFailure>

/** Four terminal states, not two. `ready` is the only one that means chat can answer;
 *  `cancelled` is terminal but is NOT a failure, so it must not render as one. */
type TerminalKind = 'ready' | 'warming_up' | 'cancelled' | 'failed' | null

interface SetupPresentation {
  readonly kind: TerminalKind
  readonly message: string | undefined
  readonly textClass: string
}

/** Total: every terminal kind states itself from the result's own fields. Nothing here can
 *  fall through to progress text, so a settled run can never display a line that arrived from
 *  some other run's progress stream. */
function outcomeMessage(outcome: SetupOutcome): string {
  if (outcome.status === 'ready') {
    return `${outcome.modelName} is ready. Chat can answer on this ${deviceNoun()} now.`
  }
  if (outcome.status === 'warming_up') {
    return `${outcome.modelName} is installed and loading. Chat will answer once it finishes starting.`
  }
  if (outcome.status === 'cancelled') return 'Setup stopped. Nothing further was downloaded.'
  return outcome.message
}

function terminalTextClass(kind: TerminalKind): string {
  if (kind === 'ready') return 'text-green-500'
  if (kind === 'failed' || kind === 'warming_up') return 'text-neutral-300'
  return 'text-neutral-400'
}

/** Pure, and single-owner. Terminal state is derived from the awaited result ALONE - `configure`
 *  always has one, because it awaits the run and its `catch` synthesises a `failed` outcome for a
 *  throw. Progress is ADVISORY: while no result exists it supplies the in-flight line, and it can
 *  never name a terminal state. It used to, and because the progress stream is broadcast to every
 *  window, that let a run this panel did not start render a terminal state here. */
function presentSetup(
  outcome: SetupOutcome | null,
  progress: SetupProgress | null
): SetupPresentation {
  if (outcome) {
    return {
      kind: outcome.status,
      message: outcomeMessage(outcome),
      textClass: terminalTextClass(outcome.status)
    }
  }
  return { kind: null, message: progress?.message, textClass: terminalTextClass(null) }
}

/** The reusable setup surface: pick a resource mode, see exactly which model it'll
 *  install, then one-click Configure. Used on the first-run gate and in Settings. */
export function SetupPanel({ onConfigured, hideHealth }: SetupPanelProps): React.ReactElement {
  const api = window.api
  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState<SetupProgress | null>(null)
  const [outcome, setOutcome] = useState<SetupOutcome | null>(null)
  const [mode, setMode] = useState<Mode | null>(null)
  const [savingMode, setSavingMode] = useState(false)
  const [modeError, setModeError] = useState<string | null>(null)
  const planRequest = useRef(0)
  const mounted = useRef(false)
  const [plan, setPlan] = useState<SetupPlan | null>(null)
  const downloadProgress = progress?.phase === 'download' ? projectProgress(progress) : null
  const downloading = downloadProgress !== null
  // The run THIS panel started, for exactly as long as it is in flight. It owns the one thing
  // progress must never choose: which model `cancel-download` targets. Display still reads
  // `progress` freely - it is advisory - but Cancel reads only the run's own recorded model.
  const activeRun = useRef<{ target: string | null } | null>(null)

  const loadPlan = useCallback(
    async (m: Mode) => {
      const request = ++planRequest.current
      setPlan(null)
      try {
        const p = (await api.setupPlan(m)) as SetupPlan | null
        if (!p) throw new Error('The model plan is unavailable.')
        if (mounted.current && request === planRequest.current) setPlan(p)
      } catch (error) {
        if (mounted.current && request === planRequest.current) {
          setModeError(
            'Your mode is saved, but its model plan could not be loaded. Reopen setup to retry.'
          )
          reportSetupFailure('resource-plan loading', error)
        }
      }
    },
    [api]
  )

  const initialize = useCallback(async (): Promise<void> => {
    const request = ++planRequest.current
    setModeError(null)
    try {
      const s = await api.getLlmSettings()
      const m = savedMode(s?.performanceMode)
      if (!mounted.current || request !== planRequest.current) return
      setMode(m)
      await loadPlan(m)
    } catch (error) {
      if (!mounted.current || request !== planRequest.current) return
      setModeError('Your saved resource mode could not be loaded. Reopen setup to retry.')
      reportSetupFailure('resource-mode loading', error)
    }
  }, [api, loadPlan])

  // Each mount owns its read. Strict Mode cleanup invalidates the previous response.
  useEffect(() => {
    mounted.current = true
    initialize().catch((error: unknown) => reportSetupFailure('initialization', error))
    return () => {
      mounted.current = false
      ++planRequest.current
    }
  }, [initialize])

  // Progress stream for the whole lifetime.
  useEffect(() => {
    const off = (
      api as unknown as { onSetupProgress?: (cb: (p: SetupProgress) => void) => () => void }
    ).onSetupProgress?.((p) => {
      // Advisory for DISPLAY only: a spinner, a line of text and a byte counter. It decides
      // neither pending nor terminal state - `configure`'s await owns the outcome and its
      // `finally` owns pending.
      setProgress(p)
      // The single exception is recorded, not read: while this panel has a run in flight, that
      // run remembers the model it is working on so Cancel has a target it owns. Progress
      // arriving when this panel started nothing updates the display and nothing else.
      const run = activeRun.current
      if (run && p.modelId) run.target = p.modelId
    })
    return () => off?.()
  }, [api])

  const pickMode = (m: Mode): void => {
    if (running || savingMode || mode === null) return
    setSavingMode(true)
    setModeError(null)
    void api
      .setLlmSettings({ performanceMode: m })
      .then(async (saved) => {
        if (!mounted.current) return
        if (!saved.ok) {
          setModeError(modelsFailureMessage(saved.failure))
          reportSetupFailure('resource-mode persistence', saved.failure)
          return
        }
        const committed = savedMode(saved.value.settings.performanceMode)
        setMode(committed)
        if (saved.value.changed.length > 0) invalidateLlmSettings()
        if (saved.value.launch?.status === 'failed') {
          setModeError(`Saved, but the model could not restart: ${saved.value.launch.message}`)
        } else if (saved.value.syncFailure) {
          setModeError('Saved on this device, but it could not be shared with your other devices.')
        }
        await loadPlan(committed)
      })
      .catch((error: unknown) => {
        if (!mounted.current) return
        setModeError(
          'The resource mode could not be confirmed. Reopen setup to check the saved value.'
        )
        reportSetupFailure('resource-mode persistence', error)
      })
      .finally(() => {
        if (mounted.current) setSavingMode(false)
      })
  }

  const configure = async (): Promise<void> => {
    if (running || savingMode || mode === null || plan === null) return
    const run: { target: string | null } = { target: null }
    activeRun.current = run
    setOutcome(null)
    setRunning(true)
    setProgress({ phase: 'select', message: `Picking a model that fits your ${deviceNoun()}...` })
    try {
      const result = await api.autoConfigure()
      setOutcome(result)
      // Only `ready` means the engine answered. `warming_up` must not dismiss the gate.
      if (result.status === 'ready') onConfigured?.()
    } catch (e) {
      setOutcome({
        status: 'failed',
        success: false,
        origin: 'host',
        message: e instanceof Error ? e.message : 'Setup failed.'
      })
    } finally {
      // The run is over, so it stops owning a cancellation target. Later progress - a straggler
      // from this run, or another panel's on this same surface - can no longer aim Cancel.
      if (activeRun.current === run) activeRun.current = null
      setRunning(false)
    }
  }

  const cancel = (): void => {
    // Only the in-flight run's own model, never whatever model progress last mentioned.
    const id = activeRun.current?.target
    if (id) {
      modelControlClient
        .control({ type: 'cancel-download', modelId: id })
        .then((stopped) => {
          if (!stopped.ok) {
            reportSetupFailure('model-download cancellation', modelsFailureMessage(stopped.failure))
          }
        })
        .catch((error: unknown) => reportSetupFailure('model-download cancellation', error))
    }
  }

  const { kind, message, textClass } = presentSetup(outcome, progress)
  const ready = kind === 'ready'
  const warming = kind === 'warming_up'
  const errored = kind === 'failed'

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
            disabled={running || savingMode || mode === null || plan === null}
            className={cn(
              'shrink-0 whitespace-nowrap rounded-lg px-4 py-2 text-xs font-medium transition-colors',
              'bg-green-600 text-white hover:bg-green-500 disabled:cursor-not-allowed disabled:opacity-60'
            )}
          >
            {running ? 'Setting up...' : kind ? 'Run again' : 'Configure'}
          </button>
        </div>

        <div className="mt-4 grid gap-px overflow-hidden rounded-lg border border-neutral-800 bg-neutral-800 lg:grid-cols-2">
          <div className="bg-neutral-950/70 p-3">
            <div className="flex items-center gap-2 text-[10px] uppercase tracking-widest text-neutral-400">
              <DesktopTower className="h-4 w-4 text-green-500" />
              Local and remote
            </div>
            <p className="mt-2 text-[11px] leading-5 text-neutral-500">
              Installed models can handle Chat, images, transcription, voice, and Computer Use on
              this {deviceNoun()}. A saved model server is an optional Chat source.
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
                onClick={() => pickMode(m.id)}
                aria-pressed={mode === m.id}
                disabled={running || savingMode || mode === null}
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
            {savingMode && ' Saving your mode...'}
          </div>
          {modeError && (
            <div className="mt-2 text-xs text-neutral-300">
              <p role="alert">{modeError}</p>
              <button
                type="button"
                disabled={savingMode || running}
                onClick={() => void initialize()}
                className="mt-1 underline"
              >
                Retry
              </button>
            </div>
          )}
        </div>

        {/* Exactly which models it will set up — the full baseline, no surprises */}
        {plan && (
          <div className="mt-3">
            <div className="mb-1.5 flex items-center justify-between text-[10px] uppercase tracking-widest text-neutral-600">
              <span>Will set up</span>
              <span className="normal-case tracking-normal text-neutral-500">
                {plan.totalDownloadGb > 0
                  ? `~${plan.totalDownloadGb.toFixed(1)} GB to download`
                  : 'all installed'}
                {' · sized for your '}
                {plan.ramGb} GB {deviceNoun()}
              </span>
            </div>
            <ul className="divide-y divide-neutral-800/70 overflow-hidden rounded-lg border border-neutral-800 bg-neutral-950/40">
              {plan.items.map((it) => {
                const Icon = KIND_ICON[it.kind]
                return (
                  <li key={it.id} className="flex items-center gap-3 px-3 py-2">
                    <Icon className="h-4 w-4 shrink-0 text-green-500" weight="regular" />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-xs text-white">
                        {it.name}
                        {it.kind === 'chat' && (
                          <span className="ml-1.5 text-[10px] text-neutral-500">
                            {' / chat + vision'}
                          </span>
                        )}
                      </div>
                      <div className="text-[10px] uppercase tracking-wider text-neutral-600">
                        {it.capability}
                      </div>
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
            <div className="mt-1.5 text-[11px] text-neutral-600">
              Chat is ready first. Transcription, voice
              {plan.items.some((i) => i.kind === 'image') ? ', and image' : ''} finish in the
              background.
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
        {message && (
          <div className="mt-4">
            <div className="flex items-center gap-2 text-xs">
              {ready && <CheckCircle weight="fill" className="h-4 w-4 text-green-500" />}
              {(errored || warming) && (
                <WarningCircle weight="fill" className="h-4 w-4 text-neutral-300" />
              )}
              <span className={textClass}>{message}</span>
            </div>
            {running && downloading && (
              <div className="mt-2">
                <div className="flex items-center gap-2">
                  <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-neutral-800">
                    <div
                      className="h-full rounded-full bg-green-500 transition-all"
                      style={{ width: `${downloadProgress.percentage ?? 0}%` }}
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
                  {downloadProgress.determinate
                    ? `${Math.round(downloadProgress.percentage ?? 0)}%`
                    : 'Downloading'}
                  {downloadProgress.totalBytes !== undefined
                    ? ` · ${formatStorageBytes(downloadProgress.currentBytes)} / ${formatStorageBytes(downloadProgress.totalBytes)}`
                    : ''}
                  {downloadProgress.bytesPerSecond !== undefined
                    ? ` · ${formatTransferSpeed(downloadProgress.bytesPerSecond)}`
                    : ''}
                </div>
              </div>
            )}
            {running && !downloading && (
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
