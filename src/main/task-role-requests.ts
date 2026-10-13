// A task role change someone asked for: over IPC, the local gateway or a paired browser. Checked
// against the model inventory, then set through task-role-models.ts. Kept apart from that module
// because the model inventory itself clears roles through it.

import type { TaskModelRole } from '../shared/computer-use-settings'
import { getCatalog, listInstalled } from './models-manager'
import { setTaskRoleModel } from './task-role-models'

/** Whether `modelId` can fill `role`: an installed or remote task model of that kind (a decision
 *  model carries the Decision tag; a grounding specialist does not). */
export async function canFillTaskRole(modelId: string, role: TaskModelRole): Promise<boolean> {
  const [catalog, installed] = await Promise.all([getCatalog(), listInstalled()])
  const models = catalog.models as Array<{ id?: string; kind?: string; tags?: readonly string[] }>
  const entry = models.find((model) => model.id === modelId)
  if (!entry || entry.kind !== 'computer_use' || !installed.includes(modelId)) return false
  return (entry.tags?.includes('Decision') ?? false) === (role === 'decision')
}

/** A role change asked for over IPC, the local gateway or a paired browser: checked, then set. */
export async function setTaskRoleFromRequest(request: {
  task?: unknown
  role?: unknown
  modelId?: unknown
}): Promise<{ success: boolean; error?: string }> {
  const { task, role, modelId } = request
  if (
    (task !== 'computer_use' && task !== 'web_use') ||
    (role !== 'decision' && role !== 'grounding') ||
    typeof modelId !== 'string' ||
    !modelId
  ) {
    return { success: false, error: 'Choose a task, a role and a model.' }
  }
  if (!(await canFillTaskRole(modelId, role))) {
    return { success: false, error: 'That model cannot fill this role.' }
  }
  setTaskRoleModel(task, role, modelId)
  return { success: true }
}
