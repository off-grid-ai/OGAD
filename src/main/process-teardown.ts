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
 * What a teardown means for residency's memory budget.
 *
 * Every outcome except `stuck` means the process is gone, so its memory is not held any more -
 * including `already-dead`, where there was nothing loaded. Answering `false` there would strand a
 * phantom resident and refuse every future admission, which is the one case where `false` is the
 * harmful answer rather than the safe one.
 */
export function reclaimFromTeardown(outcome: TeardownOutcome, engine: string): ResidentReclaim {
  if (outcome !== 'stuck') return { reclaimed: true }
  return {
    reclaimed: false,
    reason: `The ${engine} process survived SIGKILL and is still holding its memory.`
  }
}
