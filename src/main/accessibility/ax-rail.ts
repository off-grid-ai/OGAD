/**
 * The computer_use tiering: try the cheapest rail that can actually see the controls, and only pay
 * for vision when it can't (accessibility -> vision). Which rail starts, whether vision may recover,
 * and how the action maps to a task are `@offgrid/automation` / `@offgrid/use` rules; the AX host
 * (routing + run) and the vision executor are injected so the tiering runs without a screen.
 */
import {
  chooseComputerUseRail,
  parseForcedComputerUseRail,
  type ForcedComputerUseRail
} from '@offgrid/automation'
import {
  taskExecuteResult,
  taskGoalFromAction,
  taskJourneyFromAction,
  type ActionRecord,
  type ExecuteResult
} from '@offgrid/use'
import { axRailViable } from './ax-router'
import type { AxRouting } from './ax-host'
import type { ElementTaskResult } from './ax-agent'

export interface ComputerTaskTiers {
  /** Resolve + read the target app for routing, or null to fall to vision. */
  routingSnapshot(goal: string): Promise<AxRouting | null>
  /** Drive the resolved app over the accessibility rail. */
  runAx(
    goal: string,
    taskId: string,
    journeyId: string,
    app: string,
    initial: AxRouting['snapshot'],
    allowVisionRecovery: boolean
  ): Promise<ElementTaskResult>
  /** The vision-rail executor, used when AX can't drive this surface. */
  visionExecute(action: ActionRecord): Promise<ExecuteResult>
}

export type ForcedRail = ForcedComputerUseRail
export const parseForcedRail = parseForcedComputerUseRail

export interface ComputerTaskOptions {
  /** Pin the rail (A/B). Default 'auto' = tiered. */
  forcedRail?: ForcedRail
  now?: () => number
}

/** Build the tiered computer_use executor for the DeviceController's 'vision' rail. */
export function makeComputerTaskExecutor(
  tiers: ComputerTaskTiers,
  opts: ComputerTaskOptions = {}
): (action: ActionRecord) => Promise<ExecuteResult> {
  const forced = opts.forcedRail ?? 'auto'
  const now = opts.now ?? Date.now
  return async (action) => {
    const goal = taskGoalFromAction(action)
    // 'vision' forces the grounder rail: skip the AX read entirely.
    const routing = forced === 'vision' ? null : await tiers.routingSnapshot(goal)
    const choice = chooseComputerUseRail(
      forced,
      routing ? { resolved: true, viable: axRailViable(routing.snapshot) } : null
    )
    console.log(
      `[computer-task] rail=${forced} goal="${goal}" routing=${
        routing ? `${routing.app}/${routing.snapshot.elements.length} elements` : 'none'
      } -> ${choice.rail === 'accessibility' ? 'AX' : 'grounder-vision'}`
    )
    if (choice.rail === 'vision' || !routing) {
      // Dead-AX surface, no named app, or forced: the grounder-vision rail. The
      // wiring wraps this with the on-demand grounder swap + its own timing.
      console.log('[computer-task] using the grounder-vision rail')
      return tiers.visionExecute(action)
    }
    const t0 = now()
    const result = await tiers.runAx(
      goal,
      action.id,
      taskJourneyFromAction(action),
      routing.app,
      routing.snapshot,
      choice.allowVisionRecovery
    )
    console.log(
      `[computer-task] AX rail: ok=${result.ok} steps=${result.steps.length} wallMs=${now() - t0} summary="${result.summary}"`
    )
    if (!result.ok && choice.allowVisionRecovery) {
      console.log(
        `[computer-task] AX could not finish; using visual recovery for action=${action.id}`
      )
      return tiers.visionExecute(action)
    }
    // A GUI action has no generic undo; the action id is the effect handle.
    return taskExecuteResult(action, { ok: result.ok, summary: result.summary })
  }
}
