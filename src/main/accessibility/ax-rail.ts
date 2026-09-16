/**
 * The computer_use tiering (R5 T1e): try the cheapest rail that can actually
 * see the controls, and only pay for vision when it can't. Order is
 *
 *   accessibility (this rail, free, any chat model) -> vision (grounder, RAM).
 *
 * The initial decision comes from the routing snapshot's richness (ax-router):
 * a control-rich AX window drives here; a dead-AX window (Catalyst, a game, a
 * canvas) falls through to the vision executor untouched. An explicit give_up
 * stays terminal. Only repeated invalid action replies continue under vision,
 * with the same task and control owner so no GUI action is replayed.
 *
 * Pure and injected: the AX host (routing + run) and the vision executor are
 * passed in, so the tiering is unit-tested without a screen. The wiring in
 * use-runtime supplies the live hosts.
 */
import type { ActionRecord, ExecuteResult } from '@offgrid/use'
import { axRailViable } from './ax-router'
import type { AxRouting } from './ax-host'
import type { ElementTaskResult } from './ax-agent'
import type { TaskRetryCheckpoint } from '../tasks/task-retry'
import type { VisionTaskContinuation } from '../vision/vision-host'
import type { ComputerUseRail } from '../../shared/computer-use-settings'

export interface ComputerTaskTiers {
  /** Resolve + read the target app for routing, or null to fall to vision. */
  routingSnapshot(goal: string): Promise<AxRouting | null>
  /** Drive the resolved app over the accessibility rail. */
  runAx(
    goal: string,
    taskId: string,
    journeyId: string,
    app: string,
    request: {
      initial: AxRouting['snapshot']
      recoverWithVision?: (
        checkpoint: TaskRetryCheckpoint,
        continuation: VisionTaskContinuation
      ) => Promise<ExecuteResult>
    }
  ): Promise<ElementTaskResult>
  /** The vision-rail executor, used when AX can't drive this surface. */
  visionExecute(
    action: ActionRecord,
    checkpoint?: TaskRetryCheckpoint,
    continuation?: VisionTaskContinuation
  ): Promise<ExecuteResult>
}

/** Extract the task goal the same way the vision rail does. */
function goalOf(action: ActionRecord): string {
  const args = action.args as Record<string, unknown>
  return typeof args.goal === 'string' && args.goal.trim() ? args.goal : action.intent
}

/** Force a specific rail for A/B measurement. 'auto' (default) is the real
 *  tiered behaviour; 'ax'/'vision' pin the rail so the same task can be timed on
 *  each. Parsed from OFFGRID_COMPUTER_RAIL at the wiring layer. */
export type ForcedRail = 'ax' | 'vision' | 'auto'

export function parseForcedRail(value: string | undefined): ForcedRail {
  return value === 'ax' || value === 'vision' ? value : 'auto'
}

export interface ComputerTaskOptions {
  /** Pin the rail (A/B). Default 'auto' = tiered. */
  forcedRail?: ForcedRail
  enabledRails?: readonly ComputerUseRail[]
  now?: () => number
}

function isRailEnabled(enabledRails: readonly ComputerUseRail[], rail: ComputerUseRail): boolean {
  return enabledRails.includes(rail)
}

/** Build the tiered computer_use executor for the DeviceController's 'vision'
 *  rail. Tries accessibility first, then vision - unless a rail is forced. */
export function makeComputerTaskExecutor(
  tiers: ComputerTaskTiers,
  opts: ComputerTaskOptions = {}
): (action: ActionRecord) => Promise<ExecuteResult> {
  const forced = opts.forcedRail ?? 'auto'
  const enabledRails = opts.enabledRails ?? ['vision']
  const now = opts.now ?? Date.now
  return async (action) => {
    const goal = goalOf(action)
    const forceAx = forced === 'ax'
    const forceVision = forced === 'vision'
    const axEnabled = forceAx || (forced === 'auto' && isRailEnabled(enabledRails, 'ax'))
    const visionEnabled =
      forceVision || (forced === 'auto' && isRailEnabled(enabledRails, 'vision'))
    // Vision-only skips the AX read entirely.
    const routing = axEnabled ? await tiers.routingSnapshot(goal) : null
    const viable = routing !== null && axRailViable(routing.snapshot)
    // AX-only drives whenever a target app resolved, even below the richness
    // threshold. With both rails enabled, AX still requires a viable tree.
    const useAx = routing !== null && (!visionEnabled || forceAx || viable)
    console.log(
      `[computer-task] rail=${forced} goal="${goal}" routing=${
        routing ? `${routing.app}/${routing.snapshot.elements.length} elements` : 'none'
      } axViable=${viable} -> ${useAx ? 'AX' : 'grounder-vision'}`
    )
    if (useAx) {
      const t0 = now()
      const result = await tiers.runAx(
        goal,
        action.id,
        action.sourceRef ?? action.id,
        routing.app,
        {
          initial: routing.snapshot,
          ...(!visionEnabled || forceAx
            ? {}
            : {
                recoverWithVision: (checkpoint, continuation) =>
                  tiers.visionExecute(action, checkpoint, continuation)
              })
        }
      )
      const ms = now() - t0
      const stepCount = result.steps.length
      console.log(
        `[computer-task] AX rail: ok=${result.ok} steps=${stepCount} wallMs=${ms} summary="${result.summary}"`
      )
      if (!result.ok) {
        return { ok: false, detail: result.summary }
      }
      // A GUI action has no generic undo; the action id is the effect handle.
      return { ok: true, effectId: action.id }
    }
    if (!visionEnabled) {
      return { ok: false, detail: 'The Accessibility rail could not find a target app.' }
    }
    // Dead-AX surface, no named app, or Vision-only: the grounder-vision rail. The
    // wiring wraps this with the on-demand grounder swap + its own timing.
    console.log('[computer-task] using the grounder-vision rail')
    return tiers.visionExecute(action)
  }
}
