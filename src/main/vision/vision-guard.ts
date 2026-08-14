/**
 * The supervised-tier safety guard (R2-D): the vision rail actuates real
 * synthetic input on the user's live desktop, so it runs under a state machine
 * the user always overrides. Three controls, in priority order:
 *
 *  - the kill switch (Esc): halts immediately and for good. A halted session
 *    never actuates again - the run is over.
 *  - pause on user input: the moment the user touches the mouse or keyboard,
 *    the session pauses so a human and the agent are never fighting for the
 *    cursor. It resumes only when the user explicitly says so.
 *  - the step budget: a hard cap on actions, so a confused model cannot flail
 *    on the live desktop indefinitely.
 *
 * Pure state - the native input hooks and the overlay live in the host and
 * call these transitions - so the priority rules are unit-tested without a
 * screen. canActuate() is the one gate the loop checks before every action;
 * if it is false, nothing is dispatched.
 */

export type GuardState = 'running' | 'paused' | 'halted'

export interface GuardSnapshot {
  state: GuardState
  steps: number
  reason: string
}

export class VisionGuard {
  private state: GuardState = 'running'
  private steps = 0
  private reason = ''

  constructor(private readonly maxSteps: number = 40) {}

  /** The kill switch. Terminal: once halted, no transition brings it back. */
  halt(reason = 'stopped with Esc'): void {
    this.state = 'halted'
    this.reason = reason
  }

  /** User touched the mouse/keyboard - stop actuating and wait for them. A
   *  halted session stays halted (the kill switch outranks a pause). */
  pauseForUser(reason = 'you took over'): void {
    if (this.state !== 'halted') {
      this.state = 'paused'
      this.reason = reason
    }
  }

  /** The user handed control back. Only a paused session resumes; a halted one
   *  is done. */
  resume(): void {
    if (this.state === 'paused') {
      this.state = 'running'
      this.reason = ''
    }
  }

  /** Call before dispatching each action. Returns false (and does not count a
   *  step) when the session is paused, halted, or out of budget - the loop
   *  then stops or waits instead of actuating. */
  canActuate(): boolean {
    if (this.state !== 'running') {
      return false
    }
    if (this.steps >= this.maxSteps) {
      this.state = 'halted'
      this.reason = `reached the ${this.maxSteps}-step limit`
      return false
    }
    return true
  }

  /** Record that an action was dispatched. Separate from canActuate so a
   *  refused action never burns budget. */
  countStep(): void {
    this.steps += 1
  }

  get isHalted(): boolean {
    return this.state === 'halted'
  }

  get isPaused(): boolean {
    return this.state === 'paused'
  }

  snapshot(): GuardSnapshot {
    return { state: this.state, steps: this.steps, reason: this.reason }
  }
}
