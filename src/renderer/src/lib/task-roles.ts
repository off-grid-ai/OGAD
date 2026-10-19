// Task model roles for the renderer: which models can fill a role, and the roles view kept
// current. The view itself is built in main (models:task-roles); nothing here re-derives it.

import { useCallback, useEffect, useState } from 'react'
import type { TaskRolesView } from '../../../shared/task-roles-view'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const api = (): any => (window as any).api

export {
  isGroundingSpecialist,
  isDecisionModel,
  isStagedDecisionModel,
  type TaskModelChoice
} from '../../../shared/task-model-rules'

/** Main's current task roles view; null when it cannot be read. */
function fetchTaskRoles(): Promise<TaskRolesView | null> {
  return Promise.resolve(api().getTaskRoles?.())
    .then((view) => (view as TaskRolesView | null | undefined) ?? null)
    .catch(() => null)
}

/** The task roles view, kept current as roles change anywhere (here, Tasks, a paired browser). */
export function useTaskRoles(): readonly [TaskRolesView | null, () => Promise<void>] {
  const [view, setView] = useState<TaskRolesView | null>(null)
  const load = useCallback((): Promise<void> => fetchTaskRoles().then(setView), [])
  useEffect(() => {
    let live = true
    // Results land in .then: nothing is set while the effect itself runs.
    const read = (): void => void fetchTaskRoles().then((next) => live && setView(next))
    read()
    const off: unknown = api().onTaskSettingsChanged?.(read)
    return () => {
      live = false
      if (typeof off === 'function') off()
    }
  }, [])
  return [view, load] as const
}
