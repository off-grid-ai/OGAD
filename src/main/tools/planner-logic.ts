/**
 * Compatibility projection for existing Desktop imports. Shared owns planning,
 * validation, repair, routing hints, and result parsing.
 */
export {
  TOOL_PLAN_SCHEMA as PLAN_SCHEMA,
  shouldPlanTools as shouldPlan,
  buildToolPlannerPrompt as buildPlannerPrompt,
  buildToolPlannerRepairPrompt as buildPlannerRetryPrompt,
  parseToolPlan as parsePlanResult,
  backfillToolPlanGoals as backfillGoals,
  resolveToolPlanContactHandle as resolveContactHandle,
  toolRequestNamesWebsite as namesWebsite
} from '@offgrid/models'

export type {
  ToolPlanBinding as PlanBinding,
  ToolPlanStep as PlanStep,
  ToolPlan as Plan,
  ToolPlanParseResult as PlanParseResult,
  ToolPlanCatalogEntry as ToolCatalogEntry
} from '@offgrid/models'

import { parseToolPlan, type ToolPlan } from '@offgrid/models'

export function parsePlan(raw: string, knownToolNames: readonly string[]): ToolPlan {
  return parseToolPlan(raw, knownToolNames).plan
}
