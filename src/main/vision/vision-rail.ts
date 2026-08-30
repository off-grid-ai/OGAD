/**
 * The vision rail's engine adapter (R2-D): turns a computer_use Action into a
 * supervised vision run and back into an ExecuteResult. Pure and injected -
 * the live host (screen capture + robotjs actuation + grounding model +
 * overlay) is passed in as `runTask`, so this mapping is unit-tested without a
 * display.
 *
 * computer_use registers none_fuzzy for the same reason web_use does: a GUI
 * action on the live desktop is never safely auto-retried. The guard (kill
 * switch and pause) plus the user's supervision IS the reliability;
 * the model's `finished` is the executor's verdict, fired once behind the gate.
 */
import type { ActionRecord, ExecuteResult, HandlerRegistry } from '@offgrid/use'
import type { VisionTaskResult } from './vision-agent'

export interface VisionRailHost {
  runTask(goal: string, taskId: string, journeyId: string): Promise<VisionTaskResult>
}

/** Registers the computer_use handler on the vision rail. */
export function registerVisionRail(registry: HandlerRegistry): void {
  registry.register({
    type: 'computer_use',
    rail: 'vision',
    // Gates for approval; the supervised overlay covers the run itself.
    defaultRisk: 'mutate',
    // Never auto-retry a GUI action on the live desktop (see the file header).
    verification: 'none_fuzzy'
  })
}

/** The vision executor the DeviceController calls for the 'vision' rail. */
export function makeVisionRailExecutor(
  host: VisionRailHost
): (action: ActionRecord) => Promise<ExecuteResult> {
  return async (action) => {
    const args = action.args as Record<string, unknown>
    const goal = typeof args.goal === 'string' && args.goal.trim() ? args.goal : action.intent
    const result = await host.runTask(goal, action.id, action.sourceRef ?? action.id)
    if (!result.ok) {
      return { ok: false, detail: result.summary }
    }
    // A GUI action has no generic undo, so it lands as a verified confirmation
    // without an Undo affordance; the action id is the effect handle.
    return { ok: true, effectId: action.id }
  }
}
