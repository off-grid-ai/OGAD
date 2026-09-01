/**
 * The planner shell: turns a goal + the tool catalog into a plan through a
 * grammar-constrained model call, with one validation-guided repair call when
 * needed. The completion is injected (DIP) so makePlanner is unit-testable with
 * a fake; production uses the shared tool-selection route with PLAN_SCHEMA as
 * the response format. Pure decisions live in planner-logic.ts.
 */
import { generateDesktopMessages } from '../desktop-generation'
import {
  DEFAULT_TOOL_PLAN_MAX_TOKENS,
  DEFAULT_TOOL_PLAN_TIMEOUT_MS,
  generateToolPlan,
  type ToolPlan as Plan,
  type ToolPlanCatalogEntry as ToolCatalogEntry
} from '@offgrid/models'

export { ToolPlanValidationError as PlanValidationError } from '@offgrid/models'

export type PlanComplete = (
  prompt: string,
  schema: unknown,
  onReasoning?: (text: string) => void,
  signal?: AbortSignal
) => Promise<string>

export type PlanTask = (
  goal: string,
  history: { role: string; content: string }[],
  catalog: ToolCatalogEntry[],
  onReasoning?: (text: string) => void,
  signal?: AbortSignal
) => Promise<Plan>

export function makePlanner(complete: PlanComplete): PlanTask {
  return (goal, history, catalog, onReasoning, signal) =>
    generateToolPlan({
      goal,
      history,
      catalog,
      signal,
      generate: (prompt, schema, currentSignal) =>
        complete(prompt, schema, onReasoning, currentSignal)
    })
}

/** Production planner over the active model. It streams only the provider's
 * separated reasoning channel; the strict plan JSON remains internal. */
export const planTask: PlanTask = makePlanner(async (prompt, schema, onReasoning, signal) => {
  const result = await generateDesktopMessages([{ role: 'user', content: prompt }], {
    operation: { type: 'tool_selection', input: prompt, limit: 1 },
    responseFormat: schema,
    thinking: true,
    signal,
    maxTokens: DEFAULT_TOOL_PLAN_MAX_TOKENS,
    timeoutMs: DEFAULT_TOOL_PLAN_TIMEOUT_MS,
    events: {
      chunk: (chunk) => {
        if (chunk.reasoning) onReasoning?.(chunk.reasoning)
      }
    }
  })
  return result.content
})
