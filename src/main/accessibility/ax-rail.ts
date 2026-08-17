/**
 * The computer_task tiering (R5 T1e): try the cheapest rail that can actually
 * see the controls, and only pay for vision when it can't. Order is
 *
 *   accessibility (this rail, free, any chat model) -> vision (grounder, RAM).
 *
 * The decision is made ONCE, from the routing snapshot's richness (ax-router):
 * a control-rich AX window drives here; a dead-AX window (Catalyst, a game, a
 * canvas) falls through to the vision executor untouched. If AX is viable but
 * the model can't finish, that give_up is the honest answer - we do NOT then
 * re-run the whole task under vision (that would double-actuate the desktop).
 *
 * Pure and injected: the AX host (routing + run) and the vision executor are
 * passed in, so the tiering is unit-tested without a screen. The wiring in
 * use-runtime supplies the live hosts.
 */
import type { ActionRecord, ExecuteResult } from '@offgrid/use'
import { axRailViable } from './ax-router'
import type { AxRouting } from './ax-host'
import type { ElementTaskResult } from './ax-agent'

export interface ComputerTaskTiers {
  /** Resolve + read the target app for routing, or null to fall to vision. */
  routingSnapshot(goal: string): Promise<AxRouting | null>
  /** Drive the resolved app over the accessibility rail. */
  runAx(goal: string, taskId: string, app: string, initial: AxRouting['snapshot']): Promise<ElementTaskResult>
  /** The vision-rail executor, used when AX can't drive this surface. */
  visionExecute(action: ActionRecord): Promise<ExecuteResult>
}

/** Extract the task goal the same way the vision rail does. */
function goalOf(action: ActionRecord): string {
  const args = action.args as Record<string, unknown>
  return typeof args.goal === 'string' && args.goal.trim() ? args.goal : action.intent
}

/** Build the tiered computer_task executor for the DeviceController's 'vision'
 *  rail. Tries accessibility first, then vision. */
export function makeComputerTaskExecutor(
  tiers: ComputerTaskTiers
): (action: ActionRecord) => Promise<ExecuteResult> {
  return async (action) => {
    const goal = goalOf(action)
    const routing = await tiers.routingSnapshot(goal)
    if (routing && axRailViable(routing.snapshot)) {
      const result = await tiers.runAx(goal, action.id, routing.app, routing.snapshot)
      if (!result.ok) {
        return { ok: false, detail: result.summary }
      }
      // A GUI action has no generic undo; the action id is the effect handle.
      return { ok: true, effectId: action.id }
    }
    // Dead-AX surface (or no named app): the vision rail sees the whole screen.
    return tiers.visionExecute(action)
  }
}
