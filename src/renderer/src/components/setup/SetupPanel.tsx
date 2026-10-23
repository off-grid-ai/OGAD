import { useCallback, useEffect, useId, useRef, useState } from 'react'
import {
  MagicWand,
  CheckCircle,
  WarningCircle,
  ChatCircle,
  Image as ImageIcon,
  SpeakerHigh,
  Microphone,
  VideoCamera,
  MagnifyingGlass,
  DesktopTower,
  Devices,
  X
} from '@phosphor-icons/react'
import { cn } from '@renderer/lib/utils'
import { Button } from '../ui/button'
import { IconTip } from '../IconTip'
import { deviceNoun } from '@renderer/lib/device'
import { HealthPanel } from './HealthPanel'
import { SettingsRow } from '../SettingsRow'
import { formatTransferSpeed } from '@offgrid/sync'
import { projectProgress } from '@offgrid/ui'
import { formatStorageBytes } from './storage-format'
import { modelSetupErrorMessage } from '@renderer/lib/download-label'
import { OFF_GRID_DESKTOP_RELEASES_URL } from '../../constants/links'
import {
  totalDownloadGb,
  type RecMode as Mode,
  type SetupPlan,
  type SetupItem,
  type SetupItemKind as ItemKind,
  type SetupProgress
} from '../../../../shared/setup-contract'
import { AnimatePresence, motion } from 'motion/react'
import { Segmented } from '@offgrid/operator-ui/operator/segmented'
import { Section } from '@offgrid/operator-ui/operator/experience'
import {
  Progress,
  ProgressIndicator,
  ProgressTrack
} from '@offgrid/operator-ui/operator/coss/progress'
import { AnimatedNumber } from '@offgrid/operator-ui/operator/motion/animated-number'
import { TextMorph } from '@offgrid/operator-ui/operator/motion/text-morph'
import { TextShimmer } from '@offgrid/operator-ui/operator/text-shimmer'
import { Alert } from '@offgrid/operator-ui/operator/coss/alert'

const MODES: { id: Mode; label: string; hint: string }[] = [
  {
    id: 'conservative',
    label: 'Conservative',
    hint: 'Smaller chat and speech models. Image and video are optional.'
  },
  {
    id: 'balanced',
    label: 'Balanced',
    hint: 'Recommended chat model for this device. Other models are optional.'
  },
  {
    id: 'extreme',
    label: 'Extreme',
    hint: 'Larger chat and speech recommendations. Other models are optional.'
  }
]

const KIND_ICON: Record<
  ItemKind,
  React.ComponentType<{ className?: string; weight?: 'fill' | 'regular' }>
> = {
  chat: ChatCircle,
  transcription: Microphone,
  voice: SpeakerHigh,
  image: ImageIcon,
  video: VideoCamera,
  embedding: MagnifyingGlass
}

// Cached embeddings have no activation step in Auto Setup.
function canSetUpItem(item: SetupItem): boolean {
  return !(item.kind === 'embedding' && item.installed)
}

interface SetupPanelProps {
  onConfigured?: () => void // called once auto-configure succeeds (e.g. to dismiss a gate)
  hideHealth?: boolean // hide the embedded health panel (first-run gate)
}

function reportSetupFailure(operation: string, error: unknown): void {
  console.error(`[setup] ${operation} failed`, error)
}

function VideoRuntimeRecovery({
  issue,
  disabled,
  onRecheck
}: {
  issue?: string
  disabled: boolean
  onRecheck: () => void
}): React.ReactElement | null {
  if (!issue) return null
  return (
    <div className="mt-2 space-y-1.5 text-[11px] text-neutral-400" role="status">
      <p>{issue}</p>
      <div className="flex gap-2">
        <Button
          size="xs"
          variant="outline"
          onClick={() => {
            void window.api
              .openExternal(OFF_GRID_DESKTOP_RELEASES_URL)
              .catch((error: unknown) => reportSetupFailure('installer link', error))
          }}
        >
          Open app downloads
        </Button>
        <Button size="xs" variant="outline" disabled={disabled} onClick={onRecheck}>
          Check again
        </Button>
      </div>
    </div>
  )
}

const modeLabel = (id: Mode): string => MODES.find((entry) => entry.id === id)?.label ?? id

/** The mode the engine runs after a failed switch: it restores the last mode that started. */
async function modeInUse(api: Window['api'], fallback: Mode): Promise<Mode> {
  const settings = (await api.getLlmSettings().catch(() => undefined)) as
    { performanceMode?: Mode } | undefined
  return settings?.performanceMode ?? fallback
}

/** The reusable setup surface: pick a resource mode, see exactly which model it'll
 *  install, then one-click Configure. Used on the first-run gate and in Settings. */
export function SetupPanel({ onConfigured, hideHealth }: SetupPanelProps): React.ReactElement {
  const api = window.api
  const selectionId = useId()
  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState<SetupProgress | null>(null)
  const [mode, setMode] = useState<Mode>('balanced')
  const [savingMode, setSavingMode] = useState(false)
  const [modeError, setModeError] = useState('')
  const [loadingPlan, setLoadingPlan] = useState(false)
  const [plan, setPlan] = useState<SetupPlan | null>(null)
  const [selectedKinds, setSelectedKinds] = useState<Partial<Record<ItemKind, boolean>>>({
    chat: true
  })
  const selectedItems =
    plan?.items.filter((item) => selectedKinds[item.kind] && canSetUpItem(item)) ?? []
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
    if (savingMode || loadingPlan || m === mode) return
    setSavingMode(true)
    setModeError('')
    try {
      // The choice is saved first; a failed save keeps the previous mode and its plan.
      await api.setLlmSettings({ performanceMode: m })
      setMode(m)
      await loadPlan(m)
    } catch (error) {
      reportSetupFailure('resource-mode persistence', error)
      const kept = await modeInUse(api, mode)
      setMode(kept)
      setModeError(`${modeLabel(m)} could not start the model. ${modeLabel(kept)} is still in use.`)
    } finally {
      setSavingMode(false)
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
        .cancelSetupDownload(id)
        .catch((error: unknown) => reportSetupFailure('model-download cancellation', error))
    }
  }

  const done = progress?.phase === 'done'
  const errored = progress?.phase === 'error'
  let progressTextClass = 'text-neutral-400'
  if (done) progressTextClass = 'text-green-500'
  else if (errored) progressTextClass = 'text-neutral-300'

  return (
    <div className="space-y-6 font-mono">
      <div className="rounded-xl border border-neutral-800 bg-neutral-900/60 p-3">
        <div className="flex items-start gap-3">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-neutral-800 bg-neutral-800/60">
            <MagicWand className="h-4 w-4 text-green-500" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium text-white">Configure it for me</div>
            <div className="text-[11.5px] leading-snug text-neutral-500">
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
            <TextMorph as="span">
              {running ? 'Setting up...' : 'Set up selected'}
            </TextMorph>
          </button>
        </div>

        <div className="mt-3 grid gap-x-6 gap-y-2 lg:grid-cols-2">
          <div>
            <div className="flex items-center gap-2 text-[10px] uppercase tracking-widest text-neutral-400">
              <DesktopTower className="h-4 w-4 text-green-500" />
              Local and remote
            </div>
            <p className="mt-1 text-[11.5px] leading-snug text-neutral-500">
              Installed models can handle Chat, images, videos, transcription, voice, and Computer
              Use on this {deviceNoun()}. A saved model server is an optional Chat source.
            </p>
          </div>
          <div>
            <div className="flex items-center gap-2 text-[10px] uppercase tracking-widest text-neutral-400">
              <Devices className="h-4 w-4 text-green-500" />
              Control from Mobile
            </div>
            <p className="mt-1 text-[11.5px] leading-snug text-neutral-500">
              Pair Off Grid AI Mobile through Personal Mesh. Choose this Desktop by name to see and
              switch its active models. Server API keys stay on this Desktop.
            </p>
          </div>
        </div>

        {/* Resource-use selector (Conservative / Balanced / Extreme) */}
        <div className="mt-3">
          <SettingsRow inline label="Resource use" hint={MODES.find((m) => m.id === mode)?.hint}>
            <Segmented
              label="Resource use"
              size="sm"
              value={mode}
              onValueChange={(m) => {
                void pickMode(m)
              }}
              options={MODES.map((m) => ({
                id: m.id,
                label: m.label,
                disabled: savingMode || loadingPlan || running
              }))}
            />
          </SettingsRow>
          {modeError && (
            <Alert role="alert" className="mt-2 py-2 text-xs">
              {modeError}
            </Alert>
          )}
        </div>

        {/* Exactly which models it will set up — the full baseline, no surprises */}
        {plan && (
          <Section
            className="mt-5"
            label="Choose local models"
            actions={
              <span className="text-[10px] text-neutral-500">
                {downloadGb > 0
                  ? `~${formatStorageBytes(downloadGb * 1e9)} to download`
                  : selectedItems.length
                    ? 'selected models installed'
                    : 'no models selected'}
                {' · device RAM: '}
                {plan.ramGb} GB {deviceNoun()}
              </span>
            }
          >
            <ul className="divide-y divide-neutral-900">
              <AnimatePresence initial={false}>
              {plan.items.map((it) => {
                const Icon = KIND_ICON[it.kind]
                const selectable = canSetUpItem(it)
                const Row = selectable ? 'label' : 'div'
                const shownGb = it.installed ? it.sizeGb : (it.downloadSizeGb ?? it.sizeGb)
                return (
                  <motion.li
                    key={it.id}
                    layout
                    initial={{ opacity: 0, y: 6 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0 }}
                    transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
                  >
                    <Row
                      htmlFor={selectable ? `${selectionId}-${it.kind}` : undefined}
                      className={cn(
                        'flex items-center gap-3 py-2.5',
                        !selectable || running || loadingPlan ? 'cursor-default' : 'cursor-pointer'
                      )}
                    >
                      {selectable ? (
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
                      ) : (
                        <span className="h-4 w-4 shrink-0" aria-hidden="true" />
                      )}
                      <Icon className="h-4 w-4 shrink-0 text-green-500" weight="regular" />
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-xs text-white" title={it.name}>
                          {it.name}
                        </div>
                        <div className="text-[10px] uppercase tracking-wider text-neutral-600">
                          {it.capability}
                        </div>
                      </div>
                      <span className="shrink-0 text-[11px] tabular-nums text-neutral-400">
                        {shownGb ? formatStorageBytes(shownGb * 1e9) : 'size unknown'}
                      </span>
                      {it.installed && (
                        <span className="flex shrink-0 items-center gap-1 text-[10px] text-green-500">
                          <CheckCircle weight="fill" className="h-3.5 w-3.5" />
                          {selectable ? 'installed' : 'included'}
                        </span>
                      )}
                    </Row>
                  </motion.li>
                )
              })}
              </AnimatePresence>
            </ul>
            {plan.items.some((item) => item.files?.length) && (
              <details className="mt-1.5 text-[10px] text-neutral-500">
                <summary className="w-fit cursor-pointer transition-colors hover:text-foreground">
                  Required files
                </summary>
                <div className="mt-1 space-y-2 rounded-md border border-neutral-800 bg-neutral-900/40 p-2">
                  {plan.items
                    .filter((item) => item.files?.length)
                    .map((item) => (
                      <div key={item.id}>
                        <div className="text-neutral-300">{item.name}</div>
                        {item.files?.map((file) => (
                          <div key={file.name} className="break-all">
                            {file.name} ({formatStorageBytes(file.sizeBytes ?? 0)})
                          </div>
                        ))}
                      </div>
                    ))}
                </div>
              </details>
            )}
            {plan.embeddingNote && (
              <div className="mt-1.5 text-[11.5px] leading-snug text-neutral-500">
                {plan.embeddingNote}
              </div>
            )}
            {plan.videoNote && (
              <div className="mt-1.5 text-[11.5px] leading-snug text-neutral-500">
                {plan.videoNote}
              </div>
            )}
            <VideoRuntimeRecovery
              issue={plan.videoRuntimeIssue}
              disabled={running || loadingPlan}
              onRecheck={() => {
                setLoadingPlan(true)
                void loadPlan(mode).finally(() => setLoadingPlan(false))
              }}
            />
            <div className="mt-1.5 text-[11.5px] leading-snug text-neutral-500">
              Only checked models download. Each video model includes all required files. Your saved
              active choices stay unchanged.
            </div>
            <div className="mt-1 text-[11.5px] leading-snug text-neutral-500">
              For solid reasoning and tool use,{' '}
              <span className="text-neutral-300">Gemma 4 E4B</span> is the recommended minimum (4B,
              ~6 GB - fine on a 16 GB {deviceNoun()}). Smaller 2B models are lighter and add vision,
              but are noticeably weaker at reasoning.
            </div>
          </Section>
        )}

        {/* Progress / result */}
        {progress && (
          <div className="mt-4">
            <div className="flex items-center gap-2 text-xs">
              {done && <CheckCircle weight="fill" className="h-4 w-4 text-green-500" />}
              {errored && <WarningCircle weight="fill" className="h-4 w-4 text-neutral-300" />}
              {running ? (
                <TextShimmer as="span">{progress.message}</TextShimmer>
              ) : (
                <span className={progressTextClass} role={errored ? 'alert' : undefined}>
                  {errored ? modelSetupErrorMessage(progress.message) : progress.message}
                </span>
              )}
            </div>
            {running && progress.phase === 'download' && (
              <div className="mt-2">
                <div className="flex items-center gap-2">
                  <Progress
                    aria-label="Model setup progress"
                    value={downloadProgress?.percentage ?? 0}
                    className="flex-1"
                  >
                    <ProgressTrack className="bg-neutral-800">
                      <ProgressIndicator className="rounded-full bg-green-500" />
                    </ProgressTrack>
                  </Progress>
                  <IconTip label="Cancel">
                    <Button
                      size="icon-xs"
                      variant="ghost"
                      aria-label="Cancel"
                      onClick={cancel}
                      className="shrink-0 text-neutral-400 hover:text-red-400"
                    >
                      <X className="h-3.5 w-3.5" />
                    </Button>
                  </IconTip>
                </div>
                <div className="mt-1 text-[10px] text-neutral-600">
                  {downloadProgress?.determinate ? (
                    <>
                      <AnimatedNumber value={Math.round(downloadProgress.percentage ?? 0)} />%
                    </>
                  ) : (
                    'Downloading'
                  )}
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
              <Progress aria-label="Model setup progress" value={null} className="mt-2">
                <ProgressTrack className="bg-neutral-800">
                  <ProgressIndicator className="h-full w-1/3 animate-pulse rounded-full bg-green-500/60" />
                </ProgressTrack>
              </Progress>
            )}
          </div>
        )}
      </div>

      {!hideHealth && <HealthPanel />}
    </div>
  )
}
