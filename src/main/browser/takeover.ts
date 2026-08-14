/**
 * The takeover coordinator (R2-C2): when the web-task loop reaches the
 * identity boundary - a login, a one-time code, a payment - it PARKS and the
 * human acts directly in the watched pane. This owns that handoff: one place
 * that knows a task is waiting, broadcasts it, and resolves when the user
 * signals resume (or cancels).
 *
 * Same shape as the action gate host on purpose: a pending registry keyed by
 * task id, an injectable surface that renders the prompt, and a fail-closed
 * resolve. The web-task agent is constructed with `waitForTakeover` bound to
 * an instance of this; tests drive resume/cancel directly.
 */
export interface TakeoverRequest {
  taskId: string
  why: string
}

export type TakeoverOutcome = 'resumed' | 'cancelled'

export class TakeoverCoordinator {
  private readonly pending = new Map<string, (outcome: TakeoverOutcome) => void>()
  private surface: ((request: TakeoverRequest) => void) | null = null
  private clear: ((taskId: string) => void) | null = null

  /** The watched-pane surface: called with each park request, and told when a
   *  park clears so it can hide the prompt. Returns an unregister. */
  registerSurface(
    onRequest: (request: TakeoverRequest) => void,
    onClear: (taskId: string) => void
  ): () => void {
    this.surface = onRequest
    this.clear = onClear
    return () => {
      this.surface = null
      this.clear = null
    }
  }

  /**
   * Parks until the user resumes or cancels. Resolves 'resumed' with no
   * surface registered (headless / tests without a pane) so a task is never
   * wedged waiting on a UI that does not exist - the loop then re-snapshots
   * and continues, which is the safe default.
   */
  waitForTakeover(taskId: string, why: string): Promise<TakeoverOutcome> {
    if (!this.surface) {
      return Promise.resolve('resumed')
    }
    return new Promise<TakeoverOutcome>((resolve) => {
      this.pending.set(taskId, resolve)
      this.surface?.({ taskId, why })
    })
  }

  /** The renderer's verdict. False when the id is unknown (a stale click after
   *  the task already moved on). */
  resolve(taskId: string, outcome: TakeoverOutcome): boolean {
    const resolver = this.pending.get(taskId)
    if (!resolver) {
      return false
    }
    this.pending.delete(taskId)
    this.clear?.(taskId)
    resolver(outcome)
    return true
  }

  /** How many tasks are parked on a human - a health surface. */
  pendingCount(): number {
    return this.pending.size
  }
}
