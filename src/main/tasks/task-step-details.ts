/**
 * TEMPORARY re-export shim (hexagonal program 2, seat C). Owner: `@offgrid/automation`
 * (`task-step-detail`: secret redaction, typed-content redaction, reasoning-tag stripping, the
 * step/character/fact bounds, the phase vocabulary, coordinate-space defaulting). Delete when every
 * importer listed under this shim in shared/docs/hexagonal-program-2/PROGRESS_C.md imports
 * `@offgrid/automation` directly; Agent A flips the vision and pro importers in the same cutover.
 */
export {
  MAX_TASK_STEP_DETAILS,
  sanitizeComputerUseReasoning,
  visibleComputerUseModelOutput,
  sanitizeComputerUseStepDetail,
  boundComputerUseStepDetails,
  storedComputerUseStepDetails,
  type ComputerUsePhase,
  type ComputerUseStepDetail,
  type ComputerUseStepDetailInput
} from '@offgrid/automation'
