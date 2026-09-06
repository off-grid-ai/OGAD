/**
 * TEMPORARY re-export shim (hexagonal program 2, seat C). Owner: `@offgrid/automation`
 * (`task-guidance`). Delete when every importer listed under this shim in
 * shared/docs/hexagonal-program-2/PROGRESS_C.md imports `@offgrid/automation` directly; Agent A
 * flips the renderer, preload, and pro importers in the same cutover.
 */
export {
  TASK_GUIDE_MAX_TEXT_CHARS,
  TASK_GUIDE_MAX_ATTACHMENTS,
  TASK_GUIDE_MAX_ATTACHMENT_BYTES,
  TASK_GUIDE_MAX_TOTAL_ATTACHMENT_BYTES,
  TASK_GUIDE_MAX_ATTACHMENT_TEXT_CHARS,
  TASK_GUIDE_MAX_TOTAL_ATTACHMENT_TEXT_CHARS,
  TASK_GUIDE_ATTACHMENT_EXTENSIONS,
  TASK_GUIDE_ATTACHMENT_ACCEPT,
  taskGuideAttachmentExtension,
  isTaskGuideAttachmentNameAllowed,
  type TaskGuideAttachmentInput,
  type TaskGuideInput
} from '@offgrid/automation'
