// The models Web Use and Computer Use run together, task by task: one slot per role (Reasoner,
// Decision model, Grounding specialist), drawn like every other model slot (ActiveModelSlot): what
// it does, the active model as a card, Unload, and a dropdown of the other installed models. Shown on the Models screen's Tasks tab and in Active models. The lineups come from main
// (models:task-roles, the same view a paired browser gets); a change goes through the one role
// setter (models:set-task-role). This component only draws and asks.

import { useState, type ReactNode } from 'react'
import type { TaskRoleSlot, TaskRolesView } from '../../../shared/task-roles-view'
import { Section } from '@offgrid/operator-ui/operator/experience'
import { AnimatedGroup } from '@offgrid/operator-ui/operator/motion/animated-group'
import { ActiveModelSlot, type UnloadStatus } from './ActiveModelSlot'
import { isDecisionModel, isGroundingSpecialist, type TaskModelChoice } from '../lib/task-roles'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const api = (): any => (window as any).api

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
  // A role can still point at a model that is no longer on this device; say so.
  const missing = !slot.remote && !installed.includes(slot.modelId)
  return [
    ...list,
    { value: slot.modelId, label: missing ? `${slot.modelName} (not downloaded)` : slot.modelName }
  ]
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
                  return (
                    <ActiveModelSlot
                      key={slot.role}
                      ariaLabel={`${lineup.taskLabel} ${slot.label}`}
                      label={slot.label}
                      does={slot.does}
                      busy={busy !== null && slot.role !== 'reasoner'}
                      active={{
                        name: missing ? `${slot.modelName} (not downloaded)` : slot.modelName,
                        remote: slot.remote,
                        detail:
                          !slot.remote && props.localDetail ? (
                            <>On device · {props.localDetail(slot)}</>
                          ) : slot.remote ? null : (
                            'On device'
                          )
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
