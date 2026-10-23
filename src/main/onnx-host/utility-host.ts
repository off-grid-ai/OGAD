// ONNX Runtime work (voice, search) runs in Electron utility processes, not worker threads. A GPU
// driver crash inside ONNX Runtime then ends the helper, which restarts on the next request; in a
// worker thread it ended the whole app. The helper also gets its own environment, so CUDA library
// paths reach ONNX Runtime without restarting the app or leaking into other child processes.
//
// The handle mirrors the small part of the Worker API the hosts use (postMessage, message and exit
// events, terminate), so the hosts keep their request queues and protocols unchanged.

import { utilityProcess, type UtilityProcess } from 'electron'
import { onnxHelperEnv } from './onnx-runtime-env'

/** Crashes allowed per helper in CRASH_WINDOW_MS before it stays down until restarted. */
const CRASH_LIMIT = 3
const CRASH_WINDOW_MS = 60_000

export interface HelperProcess {
  postMessage(message: unknown): void
  on(event: 'message', listener: (message: never) => void): void
  on(event: 'exit', listener: (code: number) => void): void
  terminate(): Promise<void>
}

const crashes = new Map<string, number[]>()
const lastErrors = new Map<string, string>()

/** Why a helper is stopped after repeated crashes, or null while it may run. */
export function helperStoppedReason(serviceName: string): string | null {
  const now = Date.now()
  const recent = (crashes.get(serviceName) ?? []).filter((at) => now - at < CRASH_WINDOW_MS)
  crashes.set(serviceName, recent)
  return recent.length >= CRASH_LIMIT
    ? (lastErrors.get(serviceName) ?? 'It stopped repeatedly.')
    : null
}

/** Allow a stopped helper to start again (a retry, or a backend or pack change). */
export function clearHelperCrashes(serviceName: string): void {
  crashes.delete(serviceName)
  lastErrors.delete(serviceName)
}

/** Start `entry` as a utility process and send it `init` as its first message. */
export function forkHelper(
  entry: string,
  init: unknown,
  options: { serviceName: string; label: string; env?: Record<string, string> }
): HelperProcess {
  const stopped = helperStoppedReason(options.serviceName)
  if (stopped) throw new Error(`${options.label} stopped: ${stopped}`)
  const child: UtilityProcess = utilityProcess.fork(entry, [], {
    serviceName: options.serviceName,
    env: options.env ?? onnxHelperEnv(),
    stdio: 'inherit',
    // ONNX Runtime and its execution providers are native libraries loaded at run time.
    ...(process.platform === 'darwin' ? { allowLoadingUnsignedLibraries: true } : {})
  })
  let exited = false
  let terminating = false
  const exit = new Promise<void>((resolve) => {
    child.once('exit', (code) => {
      exited = true
      if (!terminating && code !== 0) {
        const now = Date.now()
        crashes.set(options.serviceName, [...(crashes.get(options.serviceName) ?? []), now])
        lastErrors.set(options.serviceName, `the helper exited with code ${code}`)
      }
      resolve()
    })
  })
  child.postMessage({ type: 'init', data: init })
  return {
    postMessage: (message) => {
      if (!exited) child.postMessage(message)
    },
    on: (event: 'message' | 'exit', listener: (value: never) => void) => {
      if (event === 'message') child.on('message', listener as (message: unknown) => void)
      else child.on('exit', listener as (code: number) => void)
    },
    terminate: async () => {
      if (exited) return
      terminating = true
      child.kill()
      await exit
    }
  }
}
