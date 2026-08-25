/**
 * The planner shell: turns a goal + the tool catalog into a plan via ONE
 * grammar-constrained model call. The completion is injected (DIP) so makePlanner
 * is unit-testable with a fake; the production `planTask` binds it to llm.chat
 * with PLAN_SCHEMA as the response format (llama.cpp compiles it to GBNF, so the
 * reply always parses). Pure decisions live in planner-logic.ts.
 */
import { llm } from '../llm'
import {
  PLAN_SCHEMA,
  buildPlannerPrompt,
  parsePlan,
  type Plan,
  type ToolCatalogEntry
} from './planner-logic'

export type PlanComplete = (prompt: string, schema: unknown) => Promise<string>

export type PlanTask = (
  goal: string,
  history: { role: string; content: string }[],
  catalog: ToolCatalogEntry[]
) => Promise<Plan>

export function makePlanner(complete: PlanComplete): PlanTask {
  return async (goal, history, catalog) => {
    const raw = await complete(buildPlannerPrompt(goal, history, catalog), PLAN_SCHEMA)
    return parsePlan(raw, catalog.map((c) => c.name))
  }
}

/** Production planner over the local model. Short, direct (thinking off). */
export const planTask: PlanTask = makePlanner((prompt, schema) =>
  llm.chat(prompt, [], 60_000, 600, { responseFormat: schema, disableThinking: true })
)
