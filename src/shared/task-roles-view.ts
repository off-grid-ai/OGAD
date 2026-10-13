// What the Models screens show about task models: for each task, the task models that run together
// (decision model, grounding specialist) and the role each plays, and for each model, the roles it
// holds. The reasoner is the Text model and is shown with the Text models, not here. Built once from the task projections
// (the same ones a task records), and sent as is to every screen: the desktop's and a paired
// browser's. Pure.

import type {
  ComputerUseActiveModel,
  ComputerUseActiveModelProjection
} from './computer-use-settings'

type Role = ComputerUseActiveModel['role']

/** What each role does, said the same everywhere. */
export const TASK_ROLE_LABELS: Record<Role, { label: string; does: string }> = {
  reasoner: { label: 'Reasoner', does: 'Plans the steps and writes text' },
  decision: { label: 'Decision model', does: 'Picks each next action' },
  grounding_specialist: { label: 'Grounding specialist', does: 'Finds what to click on screen' }
}

export interface TaskRoleSlot {
  readonly role: Role
  readonly label: string
  readonly does: string
  readonly modelId: string
  readonly modelName: string
  readonly remote: boolean
}

export interface TaskLineup {
  readonly task: 'computer_use' | 'web_use'
  readonly taskLabel: string
  readonly strategyLabel: string
  readonly slots: readonly TaskRoleSlot[]
}

export interface TaskRolesView {
  readonly tasks: readonly TaskLineup[]
  /** Per model id, what it does in the tasks: "Grounding specialist · Web Use and Computer Use". */
  readonly badges: Readonly<Record<string, string>>
}

const TASK_LABELS = { computer_use: 'Computer Use', web_use: 'Web Use' } as const

export function taskRolesView(projections: {
  readonly computerUse: ComputerUseActiveModelProjection
  readonly webUse: ComputerUseActiveModelProjection
}): TaskRolesView {
  const tasks: TaskLineup[] = (
    [
      ['web_use', projections.webUse],
      ['computer_use', projections.computerUse]
    ] as const
  ).map(([task, projection]) => ({
    task,
    taskLabel: TASK_LABELS[task],
    strategyLabel: projection.strategyLabel,
    // The reasoner is the Text model, shown with the Text models: lineups name only task models.
    slots: projection.models
      .filter((model) => model.role !== 'reasoner')
      .map((model) => ({
        role: model.role,
        ...TASK_ROLE_LABELS[model.role],
        modelId: model.modelId,
        modelName: model.modelName,
        remote: model.remote
      }))
  }))
  // role label -> tasks, per model, in the order roles first appear.
  const held = new Map<string, Map<string, string[]>>()
  for (const lineup of tasks) {
    for (const slot of lineup.slots) {
      const roles = held.get(slot.modelId) ?? new Map<string, string[]>()
      roles.set(slot.label, [...(roles.get(slot.label) ?? []), lineup.taskLabel])
      held.set(slot.modelId, roles)
    }
  }
  const badges: Record<string, string> = {}
  for (const [modelId, roles] of held) {
    badges[modelId] = [...roles]
      .map(([label, inTasks]) => `${label} · ${inTasks.join(' and ')}`)
      .join(' / ')
  }
  return { tasks, badges }
}
