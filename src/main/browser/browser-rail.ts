/**
 * The browser rail's engine adapter (R2-C3): turns a web_use Action into a
 * run of the watched loop and back into an ExecuteResult. Pure and injected -
 * the live host (WebContentsView + CDP + model + takeover pane) is passed in
 * as `runTask`, so this mapping is unit-tested without a display.
 *
 * Why web_use registers none_fuzzy, not status: a web task is not safely
 * repeatable. 'status' would let a failed verify re-execute the whole task
 * once (browse-use's retry) - and re-running "order lunch" double-orders. The
 * watched loop plus takeover IS the reliability here; the model's explicit
 * `done` is the executor's verdict, and the task fires exactly once behind the
 * approval gate. So it takes the fuzzy path (single attempt, executor verdict
 * is the status) - the same double-fire protection sends already rely on.
 */
import { WEB_USE_ACTION_TYPE, type ActionRecord, type HandlerRegistry } from '@offgrid/use'
import type { ExecuteResult } from '@offgrid/use'
import type { WebTaskResult } from './web-task-agent'
import type { TaskRetryCheckpoint } from '../tasks/task-retry'

export interface BrowserTaskRequest {
  goal: string
  url?: string
  taskId: string
  journeyId: string
  checkpoint?: TaskRetryCheckpoint
}

export interface BrowserRailHost {
  /** Run one web task end to end in the watched pane. journeyId owns the live
   * browser workspace; taskId owns this action's durable trace. */
  runTask(request: BrowserTaskRequest): Promise<WebTaskResult>
}

/** Registers the web_use handler. Kept beside the executor so the rail,
 *  risk, and verification are declared in one place the tests read. */
export function registerBrowserRail(registry: HandlerRegistry): void {
  registry.register({
    type: WEB_USE_ACTION_TYPE,
    rail: 'browser',
    // Gates for approval like any mutation; the watched pane + takeover cover
    // the identity boundary within the run.
    defaultRisk: 'mutate',
    // Fuzzy on purpose (see the file header): never auto-retry a web task.
    verification: 'none_fuzzy'
  })
}

/** The browser executor the DeviceController calls for the 'browser' rail. */
export function makeBrowserRailExecutor(
  host: BrowserRailHost
): (action: ActionRecord) => Promise<ExecuteResult> {
  return async (action) => {
    const args = action.args as Record<string, unknown>
    const goal = typeof args.goal === 'string' && args.goal.trim() ? args.goal : action.intent
    const url =
      typeof args.url === 'string' && /^https?:\/\//i.test(args.url) ? args.url : undefined
    const result = await host.runTask({
      goal,
      url,
      taskId: action.id,
      journeyId: action.sourceRef ?? action.id
    })
    if (!result.ok) {
      return { ok: false, detail: result.summary }
    }
    // The final URL is the effect handle; a web task has no generic undo, so
    // it lands as a verified confirmation without an Undo affordance.
    return { ok: true, effectId: result.finalUrl || action.id }
  }
}
