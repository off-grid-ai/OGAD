// The models Web Use and Computer Use run together, task by task: one card per role (Reasoner,
// Decision model, Grounding specialist), each saying what it does, which model fills it and where
// it runs. Shown on the Models screen's Tasks tab and in Active models. The lineups come from main
// (models:task-roles, the same view a paired browser gets); a change goes through the one role
// setter (models:set-task-role). This component only draws and asks.

import { useState, type ReactNode } from 'react'
import type { TaskRoleSlot, TaskRolesView } from '../../../shared/task-roles-view'
import { SettingsSelect } from './SettingsSelect'
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
  if (!props.view) return null
  const choose = async (
    task: 'computer_use' | 'web_use',
    slot: TaskRoleSlot,
    modelId: string
  ): Promise<void> => {
    if (!modelId || modelId === slot.modelId || slot.role === 'reasoner') return
    setBusy(modelId)
    try {
      await api().setTaskRole?.(task, slot.role === 'decision' ? 'decision' : 'grounding', modelId)
      await props.onChanged?.()
    } finally {
      setBusy(null)
    }
  }
  return (
    <div className="space-y-4">
      {props.view.tasks.map((lineup) => (
        <section key={lineup.task} aria-label={lineup.taskLabel}>
          <div className="mb-1.5 flex items-baseline justify-between gap-3">
            <span className="text-[10px] uppercase tracking-wide text-neutral-500">
              {lineup.taskLabel}
            </span>
            <span className="text-[10px] text-neutral-500">
              {lineup.slots.length > 1
                ? `${lineup.strategyLabel} · ${lineup.slots.length} models work together`
                : lineup.strategyLabel}
            </span>
          </div>
          {lineup.slots.length ? (
            <div className="grid gap-1.5 sm:grid-cols-[repeat(auto-fit,minmax(12rem,1fr))]">
              {lineup.slots.map((slot) => (
                <div
                  key={slot.role}
                  className="min-w-0 rounded-md border border-neutral-800 bg-neutral-950 px-3 py-2 text-xs"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[9px] uppercase tracking-wide text-neutral-500">
                      {slot.label}
                    </span>
                    {slot.remote ? (
                      <span className="shrink-0 rounded-sm border border-green-500/50 px-1 py-px text-[8px] uppercase tracking-wide text-green-500">
                        Remote
                      </span>
                    ) : (
                      <span className="text-[9px] text-neutral-500">
                        On device{props.localDetail ? <> · {props.localDetail(slot)}</> : null}
                      </span>
                    )}
                  </div>
                  <p className="mb-1 text-[10px] text-neutral-600">{slot.does}</p>
                  {slot.role === 'reasoner' ? (
                    <span className="block truncate text-neutral-200">{slot.modelName}</span>
                  ) : (
                    <SettingsSelect<string>
                      id={`task-${lineup.task}-${slot.role}`}
                      label={`${lineup.taskLabel} ${slot.label}`}
                      value={slot.modelId}
                      disabled={busy !== null}
                      onValueChange={(modelId) => void choose(lineup.task, slot, modelId)}
                      options={options(slot, props.models, props.installed)}
                    />
                  )}
                </div>
              ))}
            </div>
          ) : (
            <p className="px-2 py-1.5 text-xs text-neutral-600">
              {lineup.taskLabel} uses the Chat model.
            </p>
          )}
        </section>
      ))}
    </div>
  )
}
