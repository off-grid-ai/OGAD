import { useEffect, useState } from 'react'
import { SettingsSelect } from './SettingsSelect'
import { SettingsRow } from './SettingsRow'
import {
  backendChoices,
  normalizeBackendPreferences,
  type BackendModality,
  type BackendPreference,
  type BackendPreferences
} from '../../../shared/backend-preferences'
import {
  runtimeBackendLabel,
  type RuntimeBackend,
  type RuntimeId
} from '../../../shared/runtime-backends'
import type { PerformancePackStatus } from '../../../shared/performance-pack'
import { persistToggle } from '@renderer/lib/persist-toggle'
import {
  RESIDENCY_ROWS,
  residencyStatusText,
  residencySwitchLabel
} from '@renderer/lib/residency-rows'
import { Switch } from '@offgrid/operator-ui/operator/animate/switch'
import { TextMorph } from '@offgrid/operator-ui/operator/motion/text-morph'
import { AnimatePresence, motion } from 'motion/react'

const ease = [0.16, 1, 0.3, 1] as const

interface QueueCfg {
  enabled: boolean
  tier1Coexists: boolean
}

interface QueueLive {
  running: { label: string; tier: number }[]
  queued: { label: string; tier: number }[]
}

function RuntimeResidencySection(): React.ReactElement {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const api = (window as any).api
  const [modes, setModes] = useState<Record<string, string>>({})
  useEffect(() => {
    api
      .residencyGet?.()
      .then((m: Record<string, string>) => setModes(m))
      .catch(() => {})
    /* eslint-disable-next-line react-hooks/exhaustive-deps */
  }, [])

  const toggle = (modality: string, locked?: boolean): void => {
    if (locked) return
    const nextMode = modes[modality] === 'resident' ? 'on-demand' : 'resident'
    void persistToggle({ ...modes, [modality]: nextMode }, modes, setModes, () =>
      api.residencySet?.(modality, nextMode)
    )
  }

  return (
    <section aria-labelledby="model-memory-heading">
      <h4
        id="model-memory-heading"
        className="mb-1 text-[11px] uppercase tracking-wide text-neutral-500"
      >
        Model memory
      </h4>
      <p className="mb-3 text-xs text-neutral-600">
        Keep engines ready for lower latency, or load them on demand to free RAM.
      </p>
      <div className="flex flex-col divide-y divide-neutral-800/70">
        {RESIDENCY_ROWS.map((row) => {
          const resident = row.locked || modes[row.modality] === 'resident'
          return (
            // One quiet row, as in the preview: the words are the switch's hit area too.
            <label
              key={row.modality}
              data-disabled={row.locked || undefined}
              className="group flex cursor-pointer items-start justify-between gap-4 py-2.5 data-disabled:cursor-not-allowed"
            >
              <span className="min-w-0">
                <span className="block text-sm text-neutral-200 transition-colors group-hover:text-foreground">
                  {row.label}
                </span>
                <span className="block text-xs text-neutral-600">{row.hint}</span>
              </span>
              <span className="flex shrink-0 items-center gap-2">
                <span
                  className={`text-[11px] tabular-nums transition-colors duration-300 ${resident ? 'text-emerald-400' : 'text-neutral-500'}`}
                >
                  <TextMorph as="span">{residencyStatusText(row, resident)}</TextMorph>
                </span>
                <Switch
                  checked={resident}
                  onCheckedChange={() => toggle(row.modality, row.locked)}
                  disabled={row.locked}
                  aria-disabled={row.locked}
                  aria-label={residencySwitchLabel(row)}
                />
              </span>
            </label>
          )
        })}
      </div>
    </section>
  )
}

export function ModelPipelineSection(): React.ReactElement {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const api = (window as any).api
  const [cfg, setCfg] = useState<QueueCfg>({ enabled: true, tier1Coexists: true })
  const [live, setLive] = useState<QueueLive>({ running: [], queued: [] })

  useEffect(() => {
    api
      .queueConfigGet?.()
      .then(setCfg)
      .catch(() => {})
    const poll = (): void => {
      api
        .queueState?.()
        .then(setLive)
        .catch(() => {})
    }
    poll()
    const timer = setInterval(poll, 2_000)
    return () => clearInterval(timer)
    /* eslint-disable-next-line react-hooks/exhaustive-deps */
  }, [])

  const set = (patch: Partial<QueueCfg>): void => {
    void persistToggle({ ...cfg, ...patch }, cfg, setCfg, () =>
      Promise.resolve(api.queueConfigSet?.(patch)).then((persisted: QueueCfg | undefined) => {
        if (persisted) setCfg(persisted)
      })
    )
  }
  const rows = [
    {
      key: 'enabled' as const,
      label: 'Prioritize interactive work',
      hint: 'Chat and workspace jump ahead of background capture. One heavy model runs at a time.',
      on: cfg.enabled
    },
    {
      key: 'tier1Coexists' as const,
      label: 'Keep speech responsive',
      hint: 'Live dictation can run alongside a heavy job.',
      on: cfg.tier1Coexists
    }
  ]
  const activity = [...live.running, ...live.queued]

  return (
    <section aria-labelledby="processing-priority-heading">
      <h4
        id="processing-priority-heading"
        className="mb-1 text-[11px] uppercase tracking-wide text-neutral-500"
      >
        Processing priority
      </h4>
      <p className="mb-3 text-xs text-neutral-600">
        Background capture yields whenever you are actively using a model.
      </p>
      <div className="flex flex-col divide-y divide-neutral-800/70">
        {rows.map((row) => (
          <label
            key={row.key}
            className="group flex cursor-pointer items-start justify-between gap-4 py-2.5"
          >
            <span className="min-w-0">
              <span className="block text-sm text-neutral-200 transition-colors group-hover:text-foreground">
                {row.label}
              </span>
              <span className="block text-xs text-neutral-600">{row.hint}</span>
            </span>
            <Switch
              checked={row.on}
              onCheckedChange={() => set({ [row.key]: !row.on })}
              aria-label={row.label}
            />
          </label>
        ))}
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-neutral-600">
        <span className="uppercase tracking-wide">Now</span>
        <AnimatePresence mode="popLayout" initial={false}>
          {activity.length === 0 ? (
            <motion.span
              key="idle"
              layout
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.4, ease }}
              className="text-neutral-500"
            >
              idle
            </motion.span>
          ) : (
            activity.map((job, index) => (
              <motion.span
                key={`${job.label}-${String(index)}`}
                layout
                initial={{ opacity: 0, y: 4, filter: 'blur(3px)' }}
                animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
                exit={{ opacity: 0, filter: 'blur(3px)' }}
                transition={{ duration: 0.4, ease, delay: index * 0.05 }}
                className={`rounded px-1.5 py-0.5 tabular-nums transition-colors duration-300 ${live.running.includes(job) ? 'bg-emerald-500/15 text-emerald-400' : 'bg-neutral-800 text-neutral-400'}`}
              >
                {job.label}
                {live.queued.includes(job) ? ' · queued' : ''}
              </motion.span>
            ))
          )}
        </AnimatePresence>
      </div>
    </section>
  )
}

const BACKEND_LABELS: Record<BackendPreference, string> = {
  auto: 'Auto',
  cuda: 'CUDA',
  vulkan: 'Vulkan',
  metal: 'Metal',
  webgpu: 'WebGPU',
  directml: 'DirectML',
  cpu: 'CPU'
}

const RUNTIME_IDS: Record<BackendModality, RuntimeId> = {
  llm: 'chat',
  image: 'image',
  stt: 'transcription',
  tts: 'speech',
  grounding: 'grounding',
  decision: 'decision',
  embeddings: 'embeddings'
}

const BACKEND_ROW_LABELS: Record<BackendModality, string> = {
  llm: 'Chat and vision',
  image: 'Images',
  stt: 'Transcription',
  tts: 'Speech',
  grounding: 'Grounding',
  decision: 'Decider',
  embeddings: 'Search embeddings'
}

export function BackendPreferencesSection({
  modalities
}: {
  modalities: readonly BackendModality[]
}): React.ReactElement {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const api = (window as any).api
  const platform: string = api.platform ?? 'linux'
  const [preferences, setPreferences] = useState<BackendPreferences>(() =>
    normalizeBackendPreferences({}, platform)
  )
  const [running, setRunning] = useState<RuntimeBackend[]>([])
  const [packStatus, setPackStatus] = useState<PerformancePackStatus | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    if (api.backendPreferencesGet) {
      void api
        .backendPreferencesGet()
        .then((value: unknown) => {
          setPreferences(normalizeBackendPreferences(value, platform))
        })
        .catch(() => setError('Backend settings could not load.'))
    }
    const poll = (): void => {
      if (api.runtimeBackends) {
        void api
          .runtimeBackends()
          .then((value: unknown) => {
            setRunning(Array.isArray(value) ? value : [])
          })
          .catch(() => {})
      }
    }
    poll()
    if (typeof api.performancePack?.status === 'function') {
      void api.performancePack
        .status()
        .then(setPackStatus)
        .catch(() => {})
    }
    const stopPackUpdates = api.performancePack?.onChanged?.(setPackStatus)
    const timer = setInterval(poll, 3_000)
    return () => {
      clearInterval(timer)
      stopPackUpdates?.()
    }
    /* eslint-disable-next-line react-hooks/exhaustive-deps */
  }, [])

  const change = (modality: BackendModality, preference: BackendPreference): void => {
    const previous = preferences
    setPreferences({ ...preferences, [modality]: preference })
    setError('')
    void api
      .backendPreferenceSet(modality, preference)
      .then(setPreferences)
      .catch(() => {
        setPreferences(previous)
        setError('Backend setting could not be saved.')
      })
  }

  return (
    <section aria-label="Model backends">
      {error && (
        <p role="alert" className="mb-2 text-xs text-red-400">
          {error}
        </p>
      )}
      {modalities.map((modality) => {
        const runtime = running.find((entry) => entry.id === RUNTIME_IDS[modality])
        const label = `${BACKEND_ROW_LABELS[modality]} backend`
        const packOwnsCuda = ['llm', 'image', 'stt', 'grounding', 'decision'].includes(modality)
        const cudaNeedsPack =
          packOwnsCuda &&
          packStatus !== null &&
          ['available', 'downloading', 'paused', 'failed', 'not-needed'].includes(packStatus.phase)
        return (
          <SettingsRow
            inline
            key={modality}
            label={label}
            controlId={`backend-${modality}`}
            hint={
              cudaNeedsPack
                ? `Now: ${runtimeBackendLabel(runtime)}. CUDA needs the optional NVIDIA download in Setup & health. Other available backends can still run.`
                : `Now: ${runtimeBackendLabel(runtime)}. Auto tries the best available backend. Changes when the model next loads.`
            }
          >
            <SettingsSelect
              id={`backend-${modality}`}
              label={label}
              value={preferences[modality]}
              options={backendChoices(modality, platform).map((value) => ({
                value,
                label:
                  value === 'cuda' && cudaNeedsPack
                    ? 'CUDA (download required)'
                    : BACKEND_LABELS[value],
                disabled: value === 'cuda' && cudaNeedsPack
              }))}
              onValueChange={(value) => change(modality, value)}
            />
          </SettingsRow>
        )
      })}
    </section>
  )
}

export function ProcessingControls(): React.ReactElement {
  return (
    <div className="grid grid-cols-1 gap-6 border-t border-neutral-800/70 pt-5 xl:grid-cols-2">
      <ModelPipelineSection />
      <RuntimeResidencySection />
    </div>
  )
}
