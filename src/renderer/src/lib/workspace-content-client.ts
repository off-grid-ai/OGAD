/**
 * Renderer-side binding for the workspace-content transport seam.
 *
 * This module is transport only. It owns NO state: no cache, no store, no derived projection.
 * The Shared `workspaceContent` facade in the main process is the single owner of workspace
 * state; the renderer reads a snapshot, sends a typed command, or subscribes for the next
 * snapshot. Payload types come from `@offgrid/application` - never re-declare them here.
 *
 * Channels (registered in main/composition/workspace-content-ipc.ts):
 *   workspace-content:get-snapshot      request/response
 *   workspace-content:execute           request/response
 *   workspace-content:snapshot-changed  main -> renderer broadcast
 */
import type {
  WorkspaceContentCommand,
  WorkspaceContentOutcome,
  WorkspaceContentSnapshot
} from '@offgrid/application'

/** Disposes a snapshot subscription. Idempotent - calling it twice is a no-op. */
export type WorkspaceContentUnsubscribe = () => void

/** Reads the current snapshot from the main-process owner. */
export function getWorkspaceContentSnapshot(): Promise<WorkspaceContentSnapshot> {
  return window.api.workspaceContent.getSnapshot()
}

/** Sends a typed intent to the owner and resolves with its outcome. */
export function executeWorkspaceContentCommand(
  command: WorkspaceContentCommand
): Promise<WorkspaceContentOutcome> {
  return window.api.workspaceContent.execute(command)
}

/**
 * Subscribes to snapshot broadcasts.
 *
 * Cleanup contract: the returned function removes the underlying IPC listener, so no further
 * `listener` calls happen after it runs and the closure is released. Callers MUST invoke it when
 * the consuming component unmounts (return it directly from a `useEffect`). It does not prime the
 * listener with the current snapshot - call `getWorkspaceContentSnapshot` for the initial read.
 */
export function subscribeToWorkspaceContent(
  listener: (snapshot: WorkspaceContentSnapshot) => void
): WorkspaceContentUnsubscribe {
  return window.api.workspaceContent.onSnapshot(listener)
}
