/**
 * TEMPORARY re-export shim (hexagonal program 2, seat C). Owner: `@offgrid/automation`
 * (`task-execution-plan`). Delete when every importer listed under this shim in
 * shared/docs/hexagonal-program-2/PROGRESS_C.md imports `@offgrid/automation` directly; Agent A
 * flips the renderer, pro, and vision importers in the same cutover.
 */
export {
  TASK_PLAN_PREFIX,
  TASK_PHASE_PREFIX,
  TASK_PLAN_RESPONSE_FORMAT,
  normalizeTaskExecutionPlan,
  fallbackTaskExecutionPlan,
  encodeTaskExecutionPlan,
  decodeTaskExecutionPlan,
  encodeTaskPhase,
  encodeTaskExecutionPlanProgress,
  decodeTaskPhase,
  isTaskPlanControlStep,
  taskExecutionPlanProgress,
  countTaskTraceSteps,
  taskPlanPrompt,
  type TaskExecutionPhase,
  type TaskExecutionPlan,
  type TaskExecutionSurface
} from '@offgrid/automation'
