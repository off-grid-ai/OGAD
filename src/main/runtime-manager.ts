// The single seam every on-device model runtime goes through for residency. There
// is ONE place that turns a residency mode into behavior; every engine (LLM, image,
// STT, TTS) implements the same ManagedRuntime interface and registers the same way.
// So if residency works for one engine it works for all, and if it breaks it breaks
// for all — no per-engine special-casing to drift out of sync (DSP + SRP).
//
// Every engine loads lazily: on its first use, never at launch and never only because memory
// came free. The residency mode decides what happens between uses:
//   1. Memory management (here): a 'resident' engine keeps its model loaded and counts toward
//      the queue's live-memory plan, so it stays beside other models while they all fit. The
//      queue evicts it only when a job needs the memory, and it then loads again on its next use.
//   2. Job execution (in each engine's run path): a 'resident' engine routes work
//      through its warm server; an 'on-demand' engine uses its one-shot path and frees its
//      memory after each job. Each engine reads getResidencyMode(modality).

import { readFileSync } from 'node:fs'
import os from 'node:os'
import type { ResidentType } from '@offgrid/models'
import { modalityQueue, type ModalityQueue } from './modality-queue/queue'
import { getResidencyMode, type Modality, type ResidencyMode } from './runtime-residency'
import type { RuntimeBackend } from '../shared/runtime-backends'
import { sdServer } from './sd-server'
import { findSdBinaries, imageBackendForRuntime } from './imagegen/sd-runtime'
import { getBackendPreference } from './backend-preferences'

/** A model runtime the ModalityQueue can free + bring back. Every engine implements
 *  this identically — the queue never knows which concrete engine it holds. */
export interface ManagedRuntime {
  /** Which modality this runtime is (its residency setting + queue eviction id). */
  readonly modality: Modality
  /** Free resident memory NOW. MUST be idempotent/safe when already down. */
  evict(): Promise<void> | void
  /** Clear any eviction block WITHOUT reloading, after the job that evicted it ends: the
   *  engine stays down and loads on its own next use. The LLM clears its pause flag here. */
  release(): Promise<void> | void
  /** What it holds in memory now, in MB (0 when nothing is loaded). */
  footprintMB?(): number
  /** What it will hold once its current model is loaded, in MB. */
  expectedMB?(): number
}

/** Linux MemAvailable in MB (free pages plus the cache the kernel can reclaim), or null. */
function linuxAvailableMB(): number | null {
  try {
    const line = /^MemAvailable:\s+(\d+)\s+kB/m.exec(readFileSync('/proc/meminfo', 'utf8'))
    return line ? Number(line[1]) / 1024 : null
  } catch {
    return null
  }
}

/** Live memory the system can still give, in MB. macOS counts free, file-cache and purgeable pages
 *  (what Activity Monitor treats as available); Linux reads MemAvailable, since its free memory
 *  leaves out the page cache; on Windows Node's free memory is already the available figure.
 *  Read at each job's admission, so it follows the person's other apps. */
export function liveMemory(): { availableMB: number; totalMB: number } {
  const totalMB = os.totalmem() / 1024 ** 2
  if (process.platform === 'darwin' && typeof process.getSystemMemoryInfo === 'function') {
    const info = process.getSystemMemoryInfo() as {
      free: number
      fileBacked?: number
      purgeable?: number
    }
    return {
      availableMB: (info.free + (info.fileBacked ?? 0) + (info.purgeable ?? 0)) / 1024,
      totalMB
    }
  }
  const linux = process.platform === 'linux' ? linuxAvailableMB() : null
  return { availableMB: linux ?? os.freemem() / 1024 ** 2, totalMB }
}

/** Each modality's kind in the shared residency policy (text is kept longest). */
const RESIDENT_TYPE: Record<Modality, ResidentType> = {
  llm: 'text',
  image: 'image',
  stt: 'whisper',
  tts: 'tts',
  grounding: 'grounding',
  decision: 'decision',
  embeddings: 'embedding'
}

const registry = new Map<Modality, ManagedRuntime>()
let shuttingDown = false

/** Dependencies of registerRuntime, injectable so the wiring is testable against the
 *  REAL queue with a REAL runtime — the only thing swapped is the persisted-setting
 *  reader (a true IO boundary), never our own logic. */
export interface RegisterDeps {
  queue?: ModalityQueue
  readMode?: (m: Modality) => ResidencyMode
  readChatBackend?: () => RuntimeBackend
}

/** Register a runtime into the queue through the ONE residency seam. The queue calls evict()
 *  (idempotent) before a job that needs this runtime's memory, and release() when that job
 *  ends; the runtime reloads only when it is next used. */
export function registerRuntime(rt: ManagedRuntime, deps: RegisterDeps = {}): void {
  if (shuttingDown) {
    void Promise.resolve(rt.evict()).catch(() => {})
    return
  }
  const queue = deps.queue ?? modalityQueue
  const readMode = deps.readMode ?? getResidencyMode
  registry.set(rt.modality, rt)
  queue.registerEvictable(rt.modality, {
    type: RESIDENT_TYPE[rt.modality],
    // What the engine holds right now, whatever its mode (as mobile counts it): an on-demand engine
    // can stay loaded after its job (Whisper keeps its server for five minutes), and every
    // footprint reads 0 once the engine is down. The plan frees idle sidecars first, so counting a
    // loaded on-demand engine frees it, not the model it would otherwise squeeze out.
    footprintMB: () => rt.footprintMB?.() ?? 0,
    ...(rt.expectedMB ? { expectedMB: () => rt.expectedMB!() } : {}),
    evict: () => {
      // Dedicated CUDA runtimes have their own allocation/auto-fit policy. Do not
      // apply the unified-memory Mac's unconditional chat/image teardown there.
      // Explicit Unload and shutdown still call rt.evict() directly.
      if (
        process.platform !== 'darwin' &&
        readMode(rt.modality) === 'resident' &&
        (rt.modality === 'llm' || rt.modality === 'image')
      ) {
        const imageBinary =
          rt.modality === 'image'
            ? sdServer.getBinaryPath()
            : findSdBinaries('sd-server', getBackendPreference('image'))[0]
        const chat = rt.modality === 'llm' ? deps.readChatBackend?.() : undefined
        if (
          imageBinary &&
          imageBackendForRuntime(process.platform, imageBinary) === 'CUDA' &&
          (rt.modality === 'image' || (chat?.state === 'loaded' && chat.backend?.includes('CUDA')))
        )
          return
      }
      return rt.evict()
    },
    recover: () => rt.release()
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
