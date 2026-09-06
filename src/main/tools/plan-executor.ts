/**
 * The plan executor (the orchestrator's execution half). It runs each planned
 * step through the SAME dispatch the reactive loop uses (the exported runTool),
 * so approval, the @offgrid/use engine, and the semantic/browser/vision rails
 * behave identically whether a call came from the planner or from the model
 * inline - no rail, gate, or approval code is duplicated.
 *
 * Injected dispatcher => Electron-free and unit-tested: sequencing, the
 * data-flow bindings (a recipient handle from contacts_search into
 * messages_send), and the source/image merge (mirroring toolChat's) are all
 * asserted with a fake dispatch.
 */
import { resolveContactHandle, type Plan, type PlanStep } from './planner-logic'
import type { ToolCall, ToolCallStatus, UnifiedSource } from '../tools'

/** What a dispatched tool returns - structurally the ToolResult of runTool. */
export interface DispatchResult {
  text: string
  status?: ToolCallStatus
  authoritative?: boolean
  sources?: UnifiedSource[]
  imageRequest?: { prompt: string }
}

/** The dispatch seam: runTool with its ctx + extensions already bound. */
export type ToolDispatcher = (
  name: string,
  args: Record<string, unknown>
) => Promise<DispatchResult>

export interface PlanExecHooks {
  onStep?: (call: { name: string; args: Record<string, unknown> }) => void
  onToolResult?: (call: { name: string; result: string; status: ToolCallStatus }) => void
}

export interface PlanExecResult {
  toolCalls: ToolCall[]
  unified: UnifiedSource[]
  imageRequest?: { prompt: string }
  /** Per-step result text, in order (feeds bindings + the final answer). */
  results: string[]
  /** Set when execution halted early (e.g. a binding could not be resolved) -
   *  a live action must never fire with a blank required arg. */
  stopped?: string
  /** Tool-owned final response. The caller must return it without model summarization. */
  authoritativeAnswer?: string
}

/** Fill a step's args from earlier step results via its bindings. Returns null
 *  when a required binding can't be resolved - the caller then halts rather than
 *  dispatch with a blank field (never message a blank recipient). */
export function applyBindings(step: PlanStep, results: string[]): Record<string, unknown> | null {
  const args: Record<string, unknown> = { ...step.args }
  for (const b of step.bindings) {
    const source = results[b.fromStep]
    if (source === undefined) {
      return null
    }
    const value = resolveContactHandle(source, b.field)
    if (value === null) {
      return null
    }
    args[b.arg] = value
  }
  return args
}

/** Build the plan executor over an injected dispatcher (the bound runTool). */
export function makePlanExecutor(
  dispatch: ToolDispatcher
): (plan: Plan, hooks?: PlanExecHooks) => Promise<PlanExecResult> {
  return async (plan, hooks) => {
    const toolCalls: ToolCall[] = []
    const unified: UnifiedSource[] = []
    const unifiedKeys = new Set<string>()
    const results: string[] = []
    let imageRequest: { prompt: string } | undefined

    for (const step of plan.steps) {
      const args = applyBindings(step, results)
      if (args === null) {
        return {
          toolCalls,
          unified,
          imageRequest,
          results,
          stopped: `could not resolve an input for ${step.tool} from a previous step`
        }
      }
      hooks?.onStep?.({ name: step.tool, args })
      const res = await dispatch(step.tool, args)
      // Merge structured side channels exactly like the reactive loop: dedupe
      // sources into `unified`, last non-empty imageRequest wins.
      for (const s of res.sources ?? []) {
        if (unifiedKeys.has(s.key)) {
          continue
        }
        unifiedKeys.add(s.key)
        unified.push(s)
      }
      if (res.imageRequest) {
        imageRequest = res.imageRequest
      }
      const status = res.status ?? 'completed'
      toolCalls.push({ name: step.tool, args, result: res.text, status })
      results.push(res.text)
      hooks?.onToolResult?.({ name: step.tool, result: res.text, status })
      if (res.authoritative) {
        return {
          toolCalls,
          unified,
          imageRequest,
          results,
          authoritativeAnswer: res.text
        }
      }
    }
    return { toolCalls, unified, imageRequest, results }
  }
}
