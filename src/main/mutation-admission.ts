// One admission gate for application mutations that create personal data. Privacy deletion needs
// a quiescent snapshot: no new image job, gallery record, or Workspace Content command may enter
// while a scope is being erased, and already-admitted work must finish first.
/** Personal-data producer families this gate can close. */
export type MutationAdmissionScope = 'images' | 'chats'

const SCOPE_MESSAGE: Readonly<Record<MutationAdmissionScope, string>> = {
  images: 'Image work is paused while personal image data is being deleted.',
  chats: 'Chat work is paused while personal chat data is being deleted.'
}

export class ApplicationMutationAdmissionError extends Error {
  constructor(readonly scope: MutationAdmissionScope) {
    super(SCOPE_MESSAGE[scope])
    this.name = 'ApplicationMutationAdmissionError'
  }
}

/**
 * Counted suspension per producer family. `suspend` closes admission synchronously before its
 * first await, so no mutation can slip between the decision to delete and the drain. Nested or
 * concurrent deletions reopen only when the last suspension resumes.
 */
export class ApplicationMutationAdmission {
  private readonly suspensions = new Map<MutationAdmissionScope, number>()
  private readonly active = new Map<MutationAdmissionScope, Set<Promise<unknown>>>()

  isOpen(scope: MutationAdmissionScope): boolean {
    return (this.suspensions.get(scope) ?? 0) === 0
  }

  /** Refuse a mutation before the caller reserves any related state. */
  assertOpen(scope: MutationAdmissionScope): void {
    if (!this.isOpen(scope)) throw new ApplicationMutationAdmissionError(scope)
  }

  /** Run one mutation under admission and keep it in the drain set until it settles. */
  admit<Result>(scope: MutationAdmissionScope, operation: () => Promise<Result>): Promise<Result> {
    this.assertOpen(scope)
    const running = operation()
    const tracked = this.active.get(scope) ?? new Set<Promise<unknown>>()
    tracked.add(running)
    this.active.set(scope, tracked)
    void running.finally(() => tracked.delete(running)).catch(() => {})
    return running
  }

  /** Close the given families synchronously, then resolve once admitted work is idle. */
  async suspend(scopes: readonly MutationAdmissionScope[]): Promise<void> {
    const draining: Promise<unknown>[] = []
    for (const scope of scopes) {
      this.suspensions.set(scope, (this.suspensions.get(scope) ?? 0) + 1)
      draining.push(...(this.active.get(scope) ?? []))
    }
    await Promise.allSettled(draining)
  }

  /** Reopen each family owned by this suspension, on success and on failure alike. */
  resume(scopes: readonly MutationAdmissionScope[]): void {
    for (const scope of scopes) {
      const held = this.suspensions.get(scope) ?? 0
      if (held === 0) continue
      if (held === 1) this.suspensions.delete(scope)
      else this.suspensions.set(scope, held - 1)
    }
  }
}

export const applicationMutationAdmission = new ApplicationMutationAdmission()
