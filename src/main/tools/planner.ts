/**
 * The planner shell: turns a goal + the tool catalog into a plan through a
 * grammar-constrained model call, with one validation-guided repair call when
 * needed. The completion is injected (DIP) so makePlanner is unit-testable with
 * a fake; production binds it to llm.chat with PLAN_SCHEMA as the response
 * format. Pure decisions live in planner-logic.ts.
 */
import { llm } from '../llm'
import {
  PLAN_SCHEMA,
  buildPlannerPrompt,
  buildPlannerRetryPrompt,
  parsePlanResult,
  type Plan,
  type ToolCatalogEntry
} from './planner-logic'

export class PlanValidationError extends Error {
  constructor(readonly validationErrors: readonly string[]) {
    super(`Invalid structured plan after retry: ${validationErrors.join('; ')}`)
    this.name = 'PlanValidationError'
  }
}

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
  return async (goal, history, catalog, onReasoning, signal) => {
    const originalPrompt = buildPlannerPrompt(goal, history, catalog)
    const toolNames = catalog.map((c) => c.name)
    const validationErrors: string[] = []
    let prompt = originalPrompt
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const raw = await complete(prompt, PLAN_SCHEMA, onReasoning, signal)
      const result = parsePlanResult(raw, toolNames)
      if (result.valid) return result.plan
      validationErrors.push(result.error)
      prompt = buildPlannerRetryPrompt(originalPrompt, result.error)
    }
    throw new PlanValidationError(validationErrors)
  }
}

/** Production planner over the active model. It streams only the provider's
 * separated reasoning channel; the strict plan JSON remains internal. */
export const planTask: PlanTask = makePlanner(async (prompt, schema, onReasoning, signal) => {
  const result = await llm.streamChat(
    [{ role: 'user', content: prompt }],
    (text, kind) => {
      if (kind === 'reasoning') onReasoning?.(text)
    },
    {
      responseFormat: schema,
      thinking: true,
      signal,
      maxTokens: 600
    },
    60_000
  )
  return result.content
})
