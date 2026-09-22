/**
 * The computer_use routing boundary (R5 T1e): direct modes try the cheapest
 * rail that can see the controls, then use vision when it cannot. Order is
 *
 *   accessibility (this rail, free, any chat model) -> vision (grounder, RAM).
 *
 * The initial decision comes from the routing snapshot's richness (ax-router):
 * a control-rich AX window drives here; a dead-AX window (Catalyst, a game, a
 * canvas) falls through to the vision executor untouched. An explicit give_up
 * stays terminal. Only repeated invalid action replies continue under vision,
 * with the same task and control owner so no GUI action is replayed.
 *
 * Reasoning + Specialist uses the vision graph as the single task owner and
 * supplies AX/UIA controls as aligned observations instead of starting this
 * separate AX loop.
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
import type { VisionTaskContinuation } from '../vision/vision-agent'
import type { ComputerUseRail } from '../../shared/computer-use-settings'
import type { VisionExecuteResult } from '../vision/vision-rail'

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
      sessionLimitMs?: number
      recoverWithVision?: (
        checkpoint: TaskRetryCheckpoint,
        continuation: VisionTaskContinuation
      ) => Promise<VisionExecuteResult>
    }
  ): Promise<ElementTaskResult>
  /** The vision-rail executor, used when AX can't drive this surface. */
  visionExecute(
    action: ActionRecord,
    checkpoint?: TaskRetryCheckpoint,
    continuation?: VisionTaskContinuation,
    targetLabel?: string
  ): Promise<VisionExecuteResult>
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
  /** Let the vision graph own the task while it consumes aligned AX/UIA controls. */
  preferVisionGraph?: boolean
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
    const args = action.args as Record<string, unknown>
    const sessionLimitMs =
      typeof args.sessionLimitMs === 'number' && Number.isFinite(args.sessionLimitMs)
        ? args.sessionLimitMs
        : undefined
    const forceAx = forced === 'ax'
    const forceVision = forced === 'vision'
    const axEnabled = forceAx || (forced === 'auto' && isRailEnabled(enabledRails, 'ax'))
    const visionEnabled =
      forceVision || (forced === 'auto' && isRailEnabled(enabledRails, 'vision'))
    const preferVisionGraph = opts.preferVisionGraph === true && visionEnabled && !forceAx
    // Resolve and activate a named native app before either control rail runs.
    // Vision-only does not use the AX tree, but it still needs the verified app
    // identity so planning cannot guess a web version of an installed app.
    const routing = await tiers.routingSnapshot(goal)
    const viable = routing !== null && axRailViable(routing.snapshot)
    // AX-only drives whenever a target app resolved, even below the richness
    // threshold. With both rails enabled, AX still requires a viable tree.
    const useAx =
      routing !== null && axEnabled && !preferVisionGraph && (!visionEnabled || forceAx || viable)
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
          ...(sessionLimitMs ? { sessionLimitMs } : {}),
          ...(!visionEnabled || forceAx
            ? {}
            : {
                recoverWithVision: (checkpoint, continuation) =>
                  tiers.visionExecute(action, checkpoint, continuation, routing.app)
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
    return tiers.visionExecute(action, undefined, undefined, routing?.app)
  }
}
