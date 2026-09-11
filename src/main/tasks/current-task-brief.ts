/**
 * TEMPORARY re-export shim (hexagonal program 2, seat C). Owner: `@offgrid/automation`
 * (`TaskBrief` in `task-guidance`). Delete when `src/main/vision/vision-task-graph.ts` (unowned)
 * imports `TaskBrief` from `@offgrid/automation`; `src/main/accessibility/ax-agent.ts` is flipped
 * with the accessibility consumers.
 */
export { TaskBrief as CurrentTaskBrief } from '@offgrid/automation'
