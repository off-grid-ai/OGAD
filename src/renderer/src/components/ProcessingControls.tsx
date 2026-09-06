import { useEffect, useState } from 'react'
import { persistToggle } from '@renderer/lib/persist-toggle'
import {
  RESIDENCY_ROWS,
  residencyStatusText,
  residencySwitchLabel
} from '@renderer/lib/residency-rows'

interface QueueCfg {
  enabled: boolean
  tier1Coexists: boolean
}

interface QueueLive {
  running: { label: string; tier: number }[]
  queued: { label: string; tier: number }[]
}

export function RuntimeResidencySection(): React.ReactElement {
  const api = window.api
  const [modes, setModes] = useState<Record<string, string>>({})
  useEffect(() => {
    api
      .residencyGet()
      .then((m: Record<string, string>) => setModes(m))
      .catch(() => {})
    /* eslint-disable-next-line react-hooks/exhaustive-deps */
  }, [])

  const toggle = (modality: string, locked?: boolean): void => {
    if (locked) return
    const nextMode = modes[modality] === 'resident' ? 'on-demand' : 'resident'
    void persistToggle({ ...modes, [modality]: nextMode }, modes, setModes, () =>
      api.residencySet(modality, nextMode)
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
            <div key={row.modality} className="flex items-start justify-between gap-4 py-2.5">
              <div>
                <div className="text-sm text-neutral-200">{row.label}</div>
                <div className="text-xs text-neutral-600">{row.hint}</div>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <span
                  className={`text-[11px] tabular-nums ${resident ? 'text-emerald-400' : 'text-neutral-500'}`}
                >
                  {residencyStatusText(row, resident)}
                </span>
                <button
                  type="button"
                  onClick={() => toggle(row.modality, row.locked)}
                  role="switch"
                  aria-checked={resident}
                  aria-disabled={row.locked}
                  disabled={row.locked}
                  aria-label={residencySwitchLabel(row)}
                  className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-all duration-150 active:scale-95 ${resident ? 'bg-emerald-500' : 'bg-neutral-700'} ${row.locked ? 'cursor-not-allowed opacity-50' : ''}`}
                >
                  <span
                    className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${resident ? 'translate-x-6' : 'translate-x-1'}`}
                  />
                </button>
              </div>
            </div>
          )
        })}
      </div>
    </section>
  )
}

export function ModelPipelineSection(): React.ReactElement {
  const api = window.api
  const [cfg, setCfg] = useState<QueueCfg>({ enabled: true, tier1Coexists: true })
  const [live, setLive] = useState<QueueLive>({ running: [], queued: [] })

  useEffect(() => {
    api
      .queueConfigGet()
      .then(setCfg)
      .catch(() => {})
    const poll = (): void => {
      api
        .queueState()
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
      Promise.resolve(api.queueConfigSet(patch)).then((persisted: QueueCfg | undefined) => {
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
          <div key={row.key} className="flex items-start justify-between gap-4 py-2.5">
            <div>
              <div className="text-sm text-neutral-200">{row.label}</div>
              <div className="text-xs text-neutral-600">{row.hint}</div>
            </div>
            <button
              type="button"
              onClick={() => set({ [row.key]: !row.on })}
              role="switch"
              aria-checked={row.on}
              aria-label={row.label}
              className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-all duration-150 active:scale-95 ${row.on ? 'bg-emerald-500' : 'bg-neutral-700'}`}
            >
              <span
                className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${row.on ? 'translate-x-6' : 'translate-x-1'}`}
              />
            </button>
          </div>
        ))}
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-neutral-600">
        <span className="uppercase tracking-wide">Now</span>
        {activity.length === 0 ? (
          <span className="text-neutral-500">idle</span>
        ) : (
          activity.map((job, index) => (
            <span
              key={`${job.label}-${String(index)}`}
              className={`rounded px-1.5 py-0.5 tabular-nums ${live.running.includes(job) ? 'bg-emerald-500/15 text-emerald-400' : 'bg-neutral-800 text-neutral-400'}`}
            >
              {job.label}
              {live.queued.includes(job) ? ' · queued' : ''}
            </span>
          ))
        )}
      </div>
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
