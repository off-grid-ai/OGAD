// Native steps that run inside the main process (Chromium screen capture, the active-window
// addon) can fault in a graphics driver. A fault there ends the whole app before any JavaScript
// handler runs, and on the next launch the same step runs again: the app closes on every start
// (OGAD#240, a hybrid Intel + NVIDIA laptop).
//
// Each guarded step leaves a marker on disk while it runs. A marker that is still there at the
// next launch means the process died inside that step, so the step is blocked on this machine
// until the user retries it from the health panel. A clean quit removes the markers first, so
// quitting mid-capture never counts as a crash.

import fs from 'node:fs'
import path from 'node:path'
import { app } from 'electron'

export type NativeStep = 'screen-capture' | 'active-window'

export const NATIVE_STEPS: readonly NativeStep[] = ['screen-capture', 'active-window']

export const NATIVE_STEP_LABELS: Record<NativeStep, string> = {
  'screen-capture': 'Screen capture',
  'active-window': 'Active window'
}

export class NativeStepGuard {
  private readonly running = new Map<NativeStep, number>()
  private closed = false

  /** `armed: false` never writes markers: a dev build is killed on every rebuild, and that is
   *  not a crash. A marker already on disk is still honoured. */
  constructor(
    private readonly dir: string,
    private readonly armed = true
  ) {}

  private file(step: NativeStep, state: 'running' | 'blocked'): string {
    return path.join(this.dir, `${step}.${state}`)
  }

  /** At launch: every step that was mid-run when the last process died becomes blocked. */
  recoverInterrupted(): NativeStep[] {
    const interrupted = NATIVE_STEPS.filter((step) => fs.existsSync(this.file(step, 'running')))
    for (const step of interrupted) {
      fs.renameSync(this.file(step, 'running'), this.file(step, 'blocked'))
    }
    return interrupted
  }

  isBlocked(step: NativeStep): boolean {
    return fs.existsSync(this.file(step, 'blocked'))
  }

  blockedSteps(): NativeStep[] {
    return NATIVE_STEPS.filter((step) => this.isBlocked(step))
  }

  /** Run `work` unless the step crashed the app before; then answer `whenBlocked` instead. */
  async run<T>(step: NativeStep, work: () => Promise<T>, whenBlocked: () => T): Promise<T> {
    if (this.isBlocked(step)) return whenBlocked()
    if (this.closed || !this.armed) return work()
    const count = this.running.get(step) ?? 0
    if (count === 0) {
      fs.mkdirSync(this.dir, { recursive: true })
      fs.writeFileSync(this.file(step, 'running'), String(process.pid))
    }
    this.running.set(step, count + 1)
    try {
      return await work()
    } finally {
      const left = (this.running.get(step) ?? 1) - 1
      this.running.set(step, left)
      if (left === 0) fs.rmSync(this.file(step, 'running'), { force: true })
    }
  }

  /** The user asked to try a blocked step again. */
  retry(step: NativeStep): void {
    fs.rmSync(this.file(step, 'blocked'), { force: true })
  }

  /** A clean quit: the process is alive, so no running step crashed it. */
  settle(): void {
    this.closed = true
    for (const step of NATIVE_STEPS) fs.rmSync(this.file(step, 'running'), { force: true })
  }
}

let shared: NativeStepGuard | null = null

/** The guard for this profile. User data is resolved by the time any native step runs. */
export function nativeSteps(): NativeStepGuard {
  shared ??= new NativeStepGuard(path.join(app.getPath('userData'), 'native-steps'), app.isPackaged)
  return shared
}
