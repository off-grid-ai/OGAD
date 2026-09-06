/**
 * Platform input guard for Computer Use.
 *
 * @offgrid/automation owns task status and the agent/user input lease. This
 * adapter enforces that shared decision at the native I/O boundary and keeps
 * only platform-local concerns: action count and parked promise release.
 */
import {
  canAgentAct,
  automationCommandForControl,
  automationTaskReadStatus,
  classifyHumanRequiredReason,
  createAutomationTask,
  transitionAutomationTask,
  type AutomationTaskKind,
  type AutomationTaskCommand,
  type AutomationTaskSnapshot,
  type AutomationTaskStatus
} from '@offgrid/automation'
import { DEFAULT_COMPUTER_USE_STEP_BUDGET } from '../../shared/computer-use-limits'

export interface GuardSnapshot extends AutomationTaskSnapshot {
  steps: number
  reason: string
}

export interface VisionGuardOptions {
  taskId: string
  kind: AutomationTaskKind
  maxSteps?: number
}

function runningTask(taskId: string, kind: AutomationTaskKind): AutomationTaskSnapshot {
  const prepared = createAutomationTask({ taskId, kind, now: Date.now() })
  const started = transitionAutomationTask(prepared, { type: 'START' }, Date.now())
  if (!started.accepted) throw new Error(started.reason)
  return started.snapshot
}

export class VisionGuard {
  private task: AutomationTaskSnapshot
  private steps = 0
  private readonly waiters = new Set<(snapshot: GuardSnapshot) => void>()
  private actionLease = new AbortController()
  private readonly maxSteps: number

  constructor(options: VisionGuardOptions) {
    this.task = runningTask(options.taskId, options.kind)
    this.maxSteps = options.maxSteps ?? DEFAULT_COMPUTER_USE_STEP_BUDGET
  }

  /** The kill switch. STOP is terminal in the shared state owner. */
  halt(_reason = 'stopped by you'): boolean {
    if (this.apply({ type: 'STOP' })) {
      this.resolveWaiters()
      return true
    }
    return false
  }

  /** Pause parks the agent without transferring input to the user. */
  pause(_reason = 'paused by you'): boolean {
    if (!this.apply({ type: 'PAUSE' })) return false
    return true
  }

  /** Take Over transfers the shared input lease to the user. */
  takeOver(_reason = 'you took over'): boolean {
    if (!this.apply({ type: 'TAKE_OVER' })) return false
    return true
  }

  /** REQUIRE_USER transfers input to the user without ending the task. */
  requestUser(reason: string): boolean {
    if (
      !this.apply({
        type: 'REQUIRE_USER',
        reason: classifyHumanRequiredReason(reason),
        message: reason
      })
    )
      return false
    return true
  }

  /** Continue or Resume returns the input lease to the agent. */
  resume(): boolean {
    const command = automationCommandForControl('resume', {
      status: automationTaskReadStatus(this.task.status),
      inputOwner: this.task.inputLease.owner
    })
    const before = this.task
    this.apply(command)
    if (this.task !== before) {
      this.resolveWaiters()
      return true
    }
    return false
  }

  /** A fresh platform observation unlocks agent input after start or Continue. */
  markObservationReady(): boolean {
    if (!this.task.observationRequired) return this.canActuate()
    const before = this.task
    this.apply({ type: 'OBSERVATION_READY', leaseEpoch: this.task.inputLease.epoch })
    return this.task !== before && this.canActuate()
  }

  get isVerifying(): boolean {
    return this.task.status === 'verifying'
  }

  get automationStatus(): AutomationTaskStatus {
    return this.task.status
  }

  get taskId(): string {
    return this.task.taskId
  }

  get kind(): AutomationTaskKind {
    return this.task.kind
  }

  /** Capture the current agent lease before asynchronous platform work. Any
   * ownership change aborts this signal and invalidates the epoch. */
  currentActionLease(): { epoch: number; signal: AbortSignal } {
    return { epoch: this.task.inputLease.epoch, signal: this.actionLease.signal }
  }

  ownsActionLease(epoch: number): boolean {
    return (
      (this.task.status === 'running' || this.task.status === 'verifying') &&
      this.task.inputLease.owner === 'agent' &&
      this.task.inputLease.epoch === epoch
    )
  }

  /** Move the shared owner into verification. The next platform observation
   * must arrive before COMPLETE can be accepted. */
  beginVerification(): boolean {
    return this.apply({ type: 'BEGIN_VERIFICATION' })
  }

  complete(): boolean {
    return this.apply({ type: 'COMPLETE' })
  }

  fail(message: string): boolean {
    if (!this.apply({ type: 'FAIL', message })) return false
    this.resolveWaiters()
    return true
  }

  /** The loop may capture while the agent owns the lease, even when that fresh
   * observation is still required before native input can resume. */
  get canCapture(): boolean {
    return (
      (this.task.status === 'running' || this.task.status === 'verifying') &&
      this.task.inputLease.owner === 'agent'
    )
  }

  waitUntilRunnable(signal?: AbortSignal): Promise<GuardSnapshot> {
    if (!this.isPaused) return Promise.resolve(this.snapshot())
    signal?.throwIfAborted()
    return new Promise((resolve, reject) => {
      const waiter = (snapshot: GuardSnapshot): void => {
        signal?.removeEventListener('abort', onAbort)
        resolve(snapshot)
      }
      const onAbort = (): void => {
        this.waiters.delete(waiter)
        reject(signal?.reason ?? new DOMException('Aborted', 'AbortError'))
      }
      this.waiters.add(waiter)
      signal?.addEventListener('abort', onAbort, { once: true })
    })
  }

  /** The only native actuation gate. */
  canActuate(leaseEpoch: number = this.task.inputLease.epoch): boolean {
    if (!canAgentAct(this.task, leaseEpoch)) return false
    if (this.steps >= this.maxSteps) {
      const reason = `reached the ${this.maxSteps}-step limit`
      this.apply({ type: 'FAIL', message: reason })
      return false
    }
    return true
  }

  countStep(): void {
    this.steps += 1
  }

  get isHalted(): boolean {
    return (
      this.task.status === 'completed' ||
      this.task.status === 'failed' ||
      this.task.status === 'stopped'
    )
  }

  get isPaused(): boolean {
    return this.task.inputLease.owner !== 'agent' && !this.isHalted
  }

  snapshot(): GuardSnapshot {
    return {
      ...this.task,
      steps: this.steps,
      reason: this.task.failure ?? this.task.humanRequired?.message ?? ''
    }
  }

  private apply(command: AutomationTaskCommand): boolean {
    const result = transitionAutomationTask(this.task, command, Date.now())
    if (!result.accepted) return false
    const ownershipChanged = result.snapshot.inputLease.epoch !== this.task.inputLease.epoch
    this.task = result.snapshot
    if (ownershipChanged) {
      this.actionLease.abort(`input lease changed to ${this.task.inputLease.owner}`)
      this.actionLease = new AbortController()
    }
    return true
  }

  private resolveWaiters(): void {
    const snapshot = this.snapshot()
    for (const resolve of this.waiters) resolve(snapshot)
    this.waiters.clear()
  }
}
