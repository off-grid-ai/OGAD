// The single seam every on-device model runtime goes through for residency. There
// is ONE place that turns a residency mode into behavior; every engine (LLM, image,
// STT, TTS) implements the same ManagedRuntime interface and registers the same way.
// So if residency works for one engine it works for all, and if it breaks it breaks
// for all — no per-engine special-casing to drift out of sync (DSP + SRP).
//
// Two aspects of residency, both driven off the same getResidencyMode source:
//   1. Memory management (here): the queue evicts a runtime before a competing
//      heavy job and, when that job finishes, re-warms it MODE-AWARE via this seam.
//   2. Job execution (in each engine's run path): a 'resident' engine routes work
//      through its warm server; an 'on-demand' engine uses its one-shot path. Each
//      engine reads getResidencyMode(modality) — the same rule, applied once per side.

import { modalityQueue, type ModalityQueue } from './modality-queue/queue'
import { getResidencyMode, type Modality, type ResidencyMode } from './runtime-residency'

/** A model runtime the ModalityQueue can free + bring back. Every engine implements
 *  this identically — the queue never knows which concrete engine it holds. */
export interface ManagedRuntime {
  /** Which modality this runtime is (its residency setting + queue eviction id). */
  readonly modality: Modality
  /** Free resident memory NOW. MUST be idempotent/safe when already down. */
  evict(): Promise<void> | void
  /** Reload into memory now — the 'resident' re-warm after an evicting job ends. */
  warm(): Promise<void> | void
  /** Clear any eviction block WITHOUT reloading — the 'on-demand' re-warm: the
   *  engine stays down and lazily loads on its own next use. Usually a no-op for
   *  engines that already load per job; the LLM clears its pause flag here. */
  release(): Promise<void> | void
}

/** The action the queue's re-warm hook takes for a given residency mode. Pure +
 *  exported so the one rule that maps mode to behavior is unit-tested in isolation. */
export function warmActionForMode(mode: ResidencyMode): 'warm' | 'release' {
  return mode === 'resident' ? 'warm' : 'release'
}

const registry = new Map<Modality, ManagedRuntime>()
let shuttingDown = false

/** Dependencies of registerRuntime, injectable so the wiring is testable against the
 *  REAL queue with a REAL runtime — the only thing swapped is the persisted-setting
 *  reader (a true IO boundary), never our own logic. */
export interface RegisterDeps {
  queue?: ModalityQueue
  readMode?: (m: Modality) => ResidencyMode
}

/** Register a runtime into the queue through the ONE mode-aware policy. The queue
 *  always calls evict() (idempotent) before a job that displaces this runtime, then
 *  calls the mode-aware re-warm when that job ends. */
export function registerRuntime(rt: ManagedRuntime, deps: RegisterDeps = {}): void {
  if (shuttingDown) {
    void Promise.resolve(rt.evict()).catch(() => {})
    return
  }
  const queue = deps.queue ?? modalityQueue
  const readMode = deps.readMode ?? getResidencyMode
  registry.set(rt.modality, rt)
  queue.registerEvictable(rt.modality, {
    evict: () => rt.evict(),
    recover: () => rt.release(),
    warm: () => (warmActionForMode(readMode(rt.modality)) === 'warm' ? rt.warm() : rt.release())
  })
}

/** Free ONE modality's resident memory now — the user-facing "unload" button. Goes
 *  through the same idempotent evict() every engine already implements (DRY: no
 *  per-engine unload path), so it works for any modality and is safe if already down.
 *  The engine lazily reloads on its next use. Returns false if nothing is registered. */
export async function unloadRuntime(modality: Modality): Promise<boolean> {
  const rt = registry.get(modality)
  if (!rt) {
    return false
  }
  await Promise.resolve(rt.evict())
  return true
}

/** Modalities that currently have a registered runtime (so the UI can offer Unload
 *  only where there is something to free). */
export function registeredModalities(): Modality[] {
  return [...registry.keys()]
}

/** Stop every registered runtime through the same abstraction used for residency.
 * Late async registrations are immediately evicted once shutdown has begun. */
export async function shutdownRuntimes(): Promise<void> {
  shuttingDown = true
  const runtimes = [...registry.values()].reverse()
  registry.clear()
  const stops = runtimes.map((runtime) => {
    try {
      return Promise.resolve(runtime.evict())
    } catch (error) {
      return Promise.reject(error)
    }
  })
  const results = await Promise.allSettled(stops)
  const failure = results.find((result) => result.status === 'rejected')
  if (failure?.status === 'rejected') throw failure.reason
}
