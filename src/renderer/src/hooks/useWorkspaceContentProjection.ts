/**
 * Read-only reactive projection of the Shared `workspace-content` transport for renderer views.
 *
 * The main-process `WorkspaceContentFacade` is the single owner of project/conversation/message
 * state (see `../lib/workspace-content-client.ts`). This hook holds no writable domain state of
 * its own: it fetches the current snapshot once on mount, then mirrors every broadcast the owner
 * sends after a committed change. A consumer must not derive a second copy of this data that it
 * mutates locally - render straight from the snapshot this hook returns.
 */
import { useEffect, useState } from 'react'
import type { WorkspaceContentSnapshot } from '@offgrid/application'
import {
  getWorkspaceContentSnapshot,
  subscribeToWorkspaceContent
} from '@renderer/lib/workspace-content-client'

/**
 * Returns the latest known workspace-content snapshot, or `null` before the first read resolves.
 * Re-renders the caller whenever the owner broadcasts a new snapshot after a committed change.
 */
export function useWorkspaceContentProjection(): WorkspaceContentSnapshot | null {
  const [snapshot, setSnapshot] = useState<WorkspaceContentSnapshot | null>(null)

  useEffect(() => {
    let alive = true
    void getWorkspaceContentSnapshot().then((next) => {
      if (alive) setSnapshot(next)
    })
    const unsubscribe = subscribeToWorkspaceContent((next) => {
      if (alive) setSnapshot(next)
    })
    return () => {
      alive = false
      unsubscribe()
    }
  }, [])

  return snapshot
}
