// The models Web Use and Computer Use run together, task by task: one slot per role (Reasoner,
// Decision model, Grounding specialist), drawn like every other model slot (ActiveModelSlot): what
// it does, the active model as a card, Unload, and a dropdown of the other installed models. Shown on the Models screen's Tasks tab and in Active models. The lineups come from main
// (models:task-roles, the same view a paired browser gets); a change goes through the one role
// setter (models:set-task-role). This component only draws and asks.

import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { TaskRoleSlot, TaskRolesView } from '../../../shared/task-roles-view'
import { Section } from '@offgrid/operator-ui/operator/experience'
import { AnimatedGroup } from '@offgrid/operator-ui/operator/motion/animated-group'
import { ActiveModelSlot, type UnloadStatus } from './ActiveModelSlot'
import { isDecisionModel, isGroundingSpecialist, type TaskModelChoice } from '../lib/task-roles'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const api = (): any => (window as any).api

function without<T>(record: Record<string, T>, key: string): Record<string, T> {
  if (!(key in record)) return record
  const next = { ...record }
  delete next[key]
  return next
}

function options(
  slot: TaskRoleSlot,
  models: readonly TaskModelChoice[],
  installed: readonly string[]
): { value: string; label: string }[] {
  // Local and remote alike, by role: a remote server's decision model carries the Decision tag.
  const fits = (m: TaskModelChoice): boolean =>
    m.availability !== 'coming_soon' &&
    installed.includes(m.id) &&
    (slot.role === 'decision' ? isDecisionModel(m) : isGroundingSpecialist(m))
  const list = models.filter(fits).map((m) => ({ value: m.id, label: m.name }))
  if (list.some((o) => o.value === slot.modelId)) return list
  // A role can still point at a model that is no longer on this device. The card above the dropdown
  // carries that status (and the button to fetch it), so the option itself is just the name.
  return [...list, { value: slot.modelId, label: slot.modelName }]
}

export function TaskLineups(props: {
  readonly view: TaskRolesView | null
  readonly models: readonly TaskModelChoice[]
  readonly installed: readonly string[]
  /** After a role changes: the caller reloads whatever it shows besides the lineups. */
  readonly onChanged?: () => void | Promise<void>
  /** Extra detail for a slot run on this device (for example its compute backend). */
  readonly localDetail?: (slot: TaskRoleSlot) => ReactNode
}): React.ReactElement | null {
  const [busy, setBusy] = useState<string | null>(null)
  // Per role, like every other slot: a grounding specialist unloaded for one task is unloaded for both.
  const [unload, setUnload] = useState<Partial<Record<'decision' | 'grounding', UnloadStatus>>>({})
  // A role can point at a model this device never downloaded. The card for it is the Download button;
  // we track only the fetches we started here, reload the lineups once one lands, and keep a failure
  // on the card (clicking it again retries) rather than letting it slip back to "Not downloaded".
  const [downloads, setDownloads] = useState<Record<string, { percent?: number }>>({})
  const [failures, setFailures] = useState<Record<string, string>>({})
  const started = useRef(new Set<string>())
  const onChangedRef = useRef(props.onChanged)
  onChangedRef.current = props.onChanged
  const settle = (modelId: string, error?: string): void => {
    if (!started.current.delete(modelId)) return
    setDownloads((current) => without(current, modelId))
    if (error === undefined) void onChangedRef.current?.()
    else setFailures((current) => ({ ...current, [modelId]: error }))
  }
  const settleRef = useRef(settle)
  settleRef.current = settle
  useEffect(() => {
    return api()?.onModelProgress?.(
      (p: { modelId: string; percent?: number; status?: string; error?: string }) => {
        if (!started.current.has(p.modelId)) return
        if (p.status === 'completed') settleRef.current(p.modelId)
        else if (p.status === 'failed' || p.status === 'cancelled')
          settleRef.current(p.modelId, p.error || 'The download did not finish.')
        else setDownloads((current) => ({ ...current, [p.modelId]: { percent: p.percent } }))
      }
    )
  }, [])
  const download = (modelId: string): void => {
    started.current.add(modelId)
    setFailures((current) => without(current, modelId))
    setDownloads((current) => ({ ...current, [modelId]: { percent: 0 } }))
    void Promise.resolve(api()?.downloadModel?.(modelId)).then(
      (result: { success?: boolean; error?: string } | undefined) => {
        if (result?.success === false)
          settleRef.current(modelId, result.error || 'The download did not start.')
      },
      (error: unknown) =>
        settleRef.current(
          modelId,
          error instanceof Error ? error.message : 'The download did not start.'
        )
    )
  }
  if (!props.view) return null
  const choose = async (
    task: 'computer_use' | 'web_use',
    slot: TaskRoleSlot,
    modelId: string
  ): Promise<void> => {
    if (!modelId || modelId === slot.modelId || slot.role === 'reasoner') return
    const role = slot.role === 'decision' ? 'decision' : 'grounding'
    setBusy(modelId)
    try {
      await api().setTaskRole?.(task, role, modelId)
      setUnload((current) => ({ ...current, [role]: undefined }))
      await props.onChanged?.()
    } finally {
      setBusy(null)
    }
  }
  const unloadRole = async (role: 'decision' | 'grounding'): Promise<void> => {
    if (typeof api()?.unloadRuntime !== 'function') {
      setUnload((current) => ({ ...current, [role]: 'error' }))
      return
    }
    setUnload((current) => ({ ...current, [role]: 'unloading' }))
    try {
      await api().unloadRuntime(role)
      setUnload((current) => ({ ...current, [role]: 'unloaded' }))
    } catch (error) {
      console.error('[models] unload failed', error)
      setUnload((current) => ({ ...current, [role]: 'error' }))
    }
  }
  return (
    <div className="space-y-5">
      {props.view.tasks.map((lineup) => (
        // The named region stays on a plain section; the library Section owns label and arrival.
        <section key={lineup.task} aria-label={lineup.taskLabel}>
          <Section
            label={<span className="whitespace-nowrap">{lineup.taskLabel}</span>}
            actions={
              <span className="max-w-48 text-right text-xs text-neutral-500">
                {lineup.slots.length > 1
                  ? `${lineup.strategyLabel} · ${lineup.slots.length} models work together`
                  : lineup.strategyLabel}
              </span>
            }
          >
            {lineup.slots.length ? (
              <AnimatedGroup preset="blur-slide" className="grid gap-3">
                {lineup.slots.map((slot) => {
                  const role = slot.role === 'decision' ? 'decision' : 'grounding'
                  const onDevice = !slot.remote && props.installed.includes(slot.modelId)
                  const missing = !slot.remote && !props.installed.includes(slot.modelId)
                  // Only a model the catalog knows can be fetched; a stale pointer offers the dropdown.
                  const canDownload = missing && props.models.some((m) => m.id === slot.modelId)
                  const downloading = downloads[slot.modelId]
                  const failure = failures[slot.modelId]
                  return (
                    <ActiveModelSlot
                      key={slot.role}
                      ariaLabel={`${lineup.taskLabel} ${slot.label}`}
                      label={slot.label}
                      does={slot.does}
                      busy={busy !== null && slot.role !== 'reasoner'}
                      active={{
                        name: slot.modelName,
                        remote: slot.remote,
                        detail: missing ? (
                          downloading ? (
                            'Downloading…'
                          ) : failure ? (
                            <span title={failure}>Download failed</span>
                          ) : (
                            'Not downloaded'
                          )
                        ) : !slot.remote && props.localDetail ? (
                          <>On device · {props.localDetail(slot)}</>
                        ) : slot.remote ? null : (
                          'On device'
                        ),
                        // A model the role points at but the device never fetched: the card is its
                        // Download button — the one step this state owes.
                        next: canDownload
                          ? {
                              label: `Download ${slot.modelName}`,
                              onAct: () => download(slot.modelId),
                              pending: !!downloading,
                              percent: downloading?.percent
                            }
                          : undefined
                      }}
                      // The reasoner is the Text & Vision model: it is switched and unloaded there.
                      unload={
                        slot.role !== 'reasoner' && onDevice
                          ? { status: unload[role], onUnload: () => void unloadRole(role) }
                          : undefined
                      }
                      select={
                        slot.role === 'reasoner'
                          ? undefined
                          : {
                              id: `task-${lineup.task}-${slot.role}`,
                              label: `${lineup.taskLabel} ${slot.label}`,
                              value: slot.modelId,
                              disabled: busy !== null,
                              options: options(slot, props.models, props.installed),
                              onValueChange: (modelId) => void choose(lineup.task, slot, modelId)
                            }
                      }
                    />
                  )
                })}
              </AnimatedGroup>
            ) : (
              <p className="text-xs text-neutral-500">{lineup.taskLabel} uses the Chat model.</p>
            )}
          </Section>
        </section>
      ))}
    </div>
  )
}
