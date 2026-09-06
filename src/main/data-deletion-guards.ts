export type DataDeletionScope = 'chats' | 'memories' | 'captures' | 'meetings' | 'images' | 'all'
export interface DataDeletionContext {
  scope: DataDeletionScope
  olderThanDays?: number
}
export interface DataDeletionGuard {
  scopes: readonly DataDeletionScope[]
  /** This guard settles Workspace Content outbox and Sync history before deletion completes. */
  settlesWorkspacePublication?: boolean
  suspend(context: DataDeletionContext): void | Promise<void>
  /** Expand an already-held narrower lease without reacquiring its covered producers. */
  expand?(from: DataDeletionContext, to: DataDeletionContext): void | Promise<void>
  resume(context: DataDeletionContext): void | Promise<void>
}

const deletionGuards = new Map<string, DataDeletionGuard[]>()
const heldGuards = new Map<DataDeletionGuard, DataDeletionContext>()
const guardOwners = new WeakMap<DataDeletionGuard, string>()
const retiredHeldGuards = new Map<string, DataDeletionGuard>()

function acquireGuard(guard: DataDeletionGuard, context: DataDeletionContext): Promise<void> {
  const held = heldGuards.get(guard)
  if (held) {
    if (held.scope !== 'all' && context.scope === 'all') {
      const expansion = guard.expand?.(held, context)
      return Promise.resolve(expansion).then(() => {
        heldGuards.set(guard, context)
      })
    }
    return Promise.resolve()
  }
  const suspension = guard.suspend(context)
  return Promise.resolve(suspension).then(() => {
    heldGuards.set(guard, context)
    const owner = guardOwners.get(guard)
    if (owner) {
      const retired = retiredHeldGuards.get(owner)
      if (retired) heldGuards.delete(retired)
      retiredHeldGuards.delete(owner)
    }
  })
}

export function registerDataDeletionGuard(owner: string, guard: DataDeletionGuard): () => void {
  const stack = deletionGuards.get(owner) ?? []
  stack.push(guard)
  guardOwners.set(guard, owner)
  deletionGuards.set(owner, stack)
  return () => {
    const current = deletionGuards.get(owner)
    if (!current) return
    const index = current.lastIndexOf(guard)
    if (index >= 0) current.splice(index, 1)
    if (heldGuards.has(guard)) retiredHeldGuards.set(owner, guard)
    if (current.length === 0) deletionGuards.delete(owner)
  }
}

/** Close every producer together, settle publication first, and reopen producers only on success. */
export async function withDeletionGuards<T>(
  context: DataDeletionContext,
  operation: () => T | Promise<T>,
  requireWorkspacePublicationSettlement = false
): Promise<T> {
  const active = [...deletionGuards.values()]
    .map((stack) => stack.at(-1))
    .filter((guard): guard is DataDeletionGuard => Boolean(guard?.scopes.includes(context.scope)))
  if (
    requireWorkspacePublicationSettlement &&
    !active.some((guard) => guard.settlesWorkspacePublication)
  ) {
    throw new Error('Workspace Content privacy publication settlement is unavailable.')
  }
  const suspended: DataDeletionGuard[] = []
  let outcome: { ok: true; value: T } | { ok: false; error: unknown }
  try {
    const drains: Promise<void>[] = []
    for (const guard of active) {
      suspended.push(guard)
      try {
        drains.push(acquireGuard(guard, context))
      } catch (error) {
        drains.push(Promise.reject(error))
      }
    }
    const failures = (await Promise.allSettled(drains))
      .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      .map((result) => result.reason)
    if (failures.length > 0) {
      throw new AggregateError(failures, 'One or more data producers failed to suspend')
    }
    outcome = { ok: true, value: await operation() }
  } catch (error) {
    outcome = { ok: false, error }
  }

  const resumeFailures: unknown[] = []
  const resumeOrder = [...suspended].sort(
    (left, right) =>
      Number(Boolean(right.settlesWorkspacePublication)) -
      Number(Boolean(left.settlesWorkspacePublication))
  )
  for (const guard of resumeOrder) {
    try {
      await guard.resume(context)
      heldGuards.delete(guard)
    } catch (error) {
      resumeFailures.push(error)
      break
    }
  }
  if (!outcome.ok) {
    if (resumeFailures.length > 0) {
      throw new AggregateError(
        [outcome.error, ...resumeFailures],
        'Data deletion failed and one or more producers failed to resume'
      )
    }
    throw outcome.error
  }
  if (resumeFailures.length > 0) {
    throw new AggregateError(resumeFailures, 'One or more data producers failed to resume')
  }
  return outcome.value
}
