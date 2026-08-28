/**
 * Termination for the step-by-step driving loops (web_task, the AX/element
 * rail). These loops used a low step COUNT as the task-length limit, which
 * killed legitimately long tasks at 14-16 steps. A count is a bad proxy for
 * "stuck": the real signals are no observable progress and a repeating action.
 *
 * So the loops run unbounded, and this decides when to stop:
 *  - NO PROGRESS: the observable state (url/title + element identities) did not
 *    change for `noProgressLimit` steps - the last actions accomplished nothing.
 *  - REPEATED ACTION: one action signature fired `repeatLimit` times in total.
 *    This catches the A-B-A-B oscillation the loops' consecutive-repeat skip
 *    cannot see (A and B alternate, so no two in a row are identical).
 *  - HARD BACKSTOP: an absolute step ceiling, high enough that no real task
 *    reaches it - a pure seatbelt so a pathological loop cannot drive the live
 *    machine forever, NOT a task-length limit.
 *
 * Pure and injected into both loops (DIP), so termination is unit-tested once
 * without a browser or a desktop.
 */
export interface TerminationConfig {
  /** Consecutive steps with no observable state change before we stop. */
  noProgressLimit: number
  /** How many times one action signature may fire in total before it's a loop. */
  repeatLimit: number
  /** Absolute step ceiling - the runaway seatbelt, not a task-length limit. */
  hardCap: number
}

export const DEFAULT_TERMINATION: TerminationConfig = {
  noProgressLimit: 8,
  repeatLimit: 10,
  hardCap: 500
}

export type TerminationVerdict = { stop: false } | { stop: true; reason: string }

const GOING: TerminationVerdict = { stop: false }

export class LoopTerminator {
  private lastState: string | null = null
  private noProgress = 0
  private steps = 0
  private readonly actionCounts = new Map<string, number>()

  constructor(private readonly cfg: TerminationConfig = DEFAULT_TERMINATION) {}

  /**
   * Call at the START of every iteration, after reading the fresh snapshot.
   * `stateSig` is any stable projection of the observable state. Counts EVERY
   * iteration (including parse-fail / skipped ones), so a spinning loop that
   * never changes the screen is caught by no-progress, not left to the backstop.
   */
  step(stateSig: string): TerminationVerdict {
    this.steps += 1
    if (this.steps > this.cfg.hardCap) {
      return { stop: true, reason: `hit the ${this.cfg.hardCap}-step runaway backstop` }
    }
    if (this.lastState !== null && stateSig === this.lastState) {
      this.noProgress += 1
      if (this.noProgress >= this.cfg.noProgressLimit) {
        return { stop: true, reason: `made no progress for ${this.cfg.noProgressLimit} steps` }
      }
    } else {
      this.noProgress = 0
    }
    this.lastState = stateSig
    return GOING
  }

  /**
   * Call when an ACTUATING action is chosen, before firing it. Terminal or
   * unparseable steps pass null and are ignored. The same signature reaching
   * `repeatLimit` total firings is a loop (the alternating kind the consecutive
   * guard misses).
   */
  action(actionSig: string | null): TerminationVerdict {
    if (actionSig === null) {
      return GOING
    }
    const n = (this.actionCounts.get(actionSig) ?? 0) + 1
    this.actionCounts.set(actionSig, n)
    if (n >= this.cfg.repeatLimit) {
      return { stop: true, reason: `repeated the same action ${this.cfg.repeatLimit} times` }
    }
    return GOING
  }
}
