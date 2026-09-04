/**
 * Terminating a child process and SAYING whether it died — once, for every engine that spawns one.
 *
 * Three wrappers were doing the same seven lines: `try { proc.kill('SIGKILL') } catch { /* already
 * gone *\/ }`, then nulling the handle and clearing the active key regardless. A failed kill was
 * indistinguishable from a successful one, and residency was told the memory came back either way -
 * so the next admission could be let into memory nobody had released. SIGKILL failing is USUALLY a
 * dead process, and it also covers EPERM, and "usually" is not a contract.
 *
 * `terminateEngine` already owned the escalation policy for the chat engine (SIGTERM, wait, then
 * SIGKILL, and report what it took). This adapts a `ChildProcess` to it, so the answer comes from
 * waiting for the process to actually exit rather than from the signal call not throwing.
 */
import type { ChildProcess } from 'node:child_process'
import type { ResidentReclaim } from '@offgrid/models'
import {
  ENGINE_TEARDOWN_GRACE_MS,
  terminateEngine,
  type TeardownOutcome
} from './llm/engine-teardown'

/** Is this process still running right now? */
export function processAlive(proc: ChildProcess): boolean {
  return proc.exitCode === null && proc.signalCode === null
}

/** Resolve true if the process exits within `timeoutMs`, false on timeout. */
export function waitForProcessExit(proc: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (!processAlive(proc)) return Promise.resolve(true)
  return new Promise((resolve) => {
    const onExit = (): void => {
      clearTimeout(timer)
      resolve(true)
    }
    const timer = setTimeout(() => {
      proc.off('close', onExit)
      resolve(false)
    }, timeoutMs)
    proc.once('close', onExit)
  })
}

/**
 * Terminate a spawned engine, escalating SIGTERM to SIGKILL, and report what it took.
 *
 * `sendSignal` must not throw, per `TeardownEffects`: a signal to a pid that has already exited
 * raises ESRCH, which is the state we wanted, and the liveness recheck inside `terminateEngine`
 * is what turns that into `already-dead` rather than a failure.
 */
export function terminateChildProcess(
  proc: ChildProcess,
  graceMs: number = ENGINE_TEARDOWN_GRACE_MS
): Promise<TeardownOutcome> {
  return terminateEngine(
    {
      isAlive: () => processAlive(proc),
      sendSignal: (signal) => {
        try {
          proc.kill(signal)
        } catch {
          // EXPECTED ABSENCE: the process may exit between the liveness check and the signal, and
          // ESRCH from a dead pid IS the state this is trying to reach. `terminateEngine` rechecks
          // liveness, so a race with a natural exit is reported as the exit it was.
        }
      },
      waitForExit: (timeoutMs) => waitForProcessExit(proc, timeoutMs)
    },
    graceMs
  )
}

/**
 * Processes that would not die, kept so the question can be answered later.
 *
 * THE PRINCIPLE, because it is the defect this exists to prevent: "this object no longer manages
 * it" does not make memory reclaimed. Ownership and reclamation are different facts, and
 * discarding the handle changes only the first.
 *
 * The first version of this cleared the handle before knowing whether the process stopped. A stuck
 * process therefore produced a truthful `reclaimed: false` and then, on the very next call, a
 * confident `reclaimed: true` - because there was no longer a process to ask about. Residency acts
 * on the second, drops the record, and readmits into memory the orphan is still holding. A
 * truthful first answer followed by a false second one is worse than a consistently vague one.
 *
 * So a process that survives termination is RETAINED here. Every later reclaim re-checks that
 * exact process and keeps answering `reclaimed: false` until its exit is PROVEN - not until a
 * timeout, not until a handle is gone. If it never exits, `reclaimed: false` forever is the correct
 * answer.
 */
export interface ProcessTeardown {
  /**
   * Terminate `proc` and answer. A process that will not die is retained, not forgotten.
   *
   * `outcome` rides along for a caller that REPORTS what it took (the chat engine's unload surfaces
   * it to the renderer). It is not a second answer to "is the memory back" - `reclaim` is the only
   * answer to that, and it is the one every caller must act on.
   */
  terminate(proc: ChildProcess): Promise<{
    readonly outcome: TeardownOutcome
    readonly reclaim: ResidentReclaim
  }>
  /**
   * Re-ask about anything stranded. Answers `reclaimed: true` only once every retained process has
   * been observed to exit, which is what makes a later call unable to invent a release.
   */
  recheck(): Promise<ResidentReclaim>
  /**
   * Is a stranded process still alive? A spawn path MUST refuse while this is true: starting a
   * replacement beside a live orphan is how two processes come to hold model memory while
   * residency believes none do.
   */
  hasStranded(): boolean
  /** How many are stranded, for a report. */
  strandedCount(): number
}

/**
 * May a replacement process be started right now?
 *
 * The admission rule for a spawn, in one place because three engines need it and each one had it
 * inline: a stranded process is retried first, and starting a replacement while it is still alive
 * would put two processes on one port both holding model weights while residency believes none do.
 * Throws the tracker's own reason, so the caller reports what is actually wrong rather than
 * inventing a message for it.
 */
export async function requireNoStrandedProcess(teardown: ProcessTeardown): Promise<void> {
  if (!teardown.hasStranded()) return
  const reclaim = await teardown.recheck()
  if (!reclaim.reclaimed) throw new Error(reclaim.reason)
}

export function createProcessTeardown(
  engine: string,
  graceMs: number = ENGINE_TEARDOWN_GRACE_MS
): ProcessTeardown {
  /** Retained references. The only thing that can answer the question after the fact. */
  const stranded = new Set<ChildProcess>()

  /** Drop the ones that have since exited. Node reaps its own children, so an exit IS observable. */
  const pruneExited = (): void => {
    for (const proc of [...stranded]) if (!processAlive(proc)) stranded.delete(proc)
  }

  const refusal = (): ResidentReclaim => ({
    reclaimed: false,
    reason:
      stranded.size === 1
        ? `A ${engine} process survived termination and is still holding its memory.`
        : `${stranded.size} ${engine} processes survived termination and are still holding their memory.`
  })

  const settle = (): ResidentReclaim => {
    pruneExited()
    return stranded.size === 0 ? { reclaimed: true } : refusal()
  }

  return {
    terminate: async (proc) => {
      const outcome = await terminateChildProcess(proc, graceMs)
      if (outcome === 'stuck') stranded.add(proc)
      else stranded.delete(proc)
      // Even a successful termination answers through `settle`: this process let go, but an EARLIER
      // one that never did is still holding memory, and residency must not hear otherwise.
      return { outcome, reclaim: settle() }
    },
    recheck: async () => {
      pruneExited()
      // Try again rather than only looking: a process uninterruptible a moment ago - a wedged GPU
      // call, a driver in a kernel wait - can become killable once that call returns.
      for (const proc of [...stranded]) {
        if ((await terminateChildProcess(proc, graceMs)) !== 'stuck') stranded.delete(proc)
      }
      return settle()
    },
    hasStranded: () => {
      pruneExited()
      return stranded.size > 0
    },
    strandedCount: () => {
      pruneExited()
      return stranded.size
    }
  }
}
