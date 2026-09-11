/**
 * The browser rail's engine adapter: turns a web_use Action into a run of the watched loop and back
 * into an ExecuteResult. The handler declaration (rail, risk, verification) and the action -> task
 * mapping are `@offgrid/use`'s; the live host (WebContentsView + CDP + model + takeover pane) is
 * passed in as `runTask`, so this stays unit-testable without a display.
 */
import {
  taskExecuteResult,
  WEB_USE_HANDLER,
  webUseTaskRequest,
  type ActionRecord,
  type ExecuteResult,
  type HandlerRegistry,
  type WebUseTaskRequest
} from '@offgrid/use'
import type { TaskRetryCheckpoint } from '@offgrid/automation'

export interface WebTaskResult {
  ok: boolean
  summary: string
  steps: string[]
  takeovers: number
  finalUrl: string
}

export interface BrowserTaskRequest extends WebUseTaskRequest {
  checkpoint?: TaskRetryCheckpoint
}

export interface BrowserRailHost {
  /** Run one web task end to end in the watched pane. journeyId owns the live
   * browser workspace; taskId owns this action's durable trace. */
  runTask(request: BrowserTaskRequest): Promise<WebTaskResult>
}

/** Registers the shared web_use handler. */
export function registerBrowserRail(registry: HandlerRegistry): void {
  registry.register(WEB_USE_HANDLER)
}

/** The browser executor the DeviceController calls for the 'browser' rail. */
export function makeBrowserRailExecutor(
  host: BrowserRailHost
): (action: ActionRecord) => Promise<ExecuteResult> {
  return async (action) => {
    const result = await host.runTask(webUseTaskRequest(action))
    return taskExecuteResult(action, result)
  }
}
