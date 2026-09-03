/**
 * TEMPORARY re-export shim (hexagonal program 2, seat C). Owner: `@offgrid/automation`
 * (`task-launch-identity`). Delete when `src/main/tools/nativeActionToolExtension.ts` and
 * `src/main/actions/use-runtime.ts` (Agent A / unowned) import `@offgrid/automation` directly.
 */
export {
  actionArgsWithTaskLaunch,
  taskLaunchFromActionArgs,
  type AuthenticatedTaskLaunch
} from '@offgrid/automation'
