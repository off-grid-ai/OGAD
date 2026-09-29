// ModalityQueue — the memory-admission scheduler for heavy model work.
//
// On a 16GB unified-memory Mac two big models resident at once (chat + image, or
// chat + replay-vision) overflow RAM and swap the whole machine into a beachball.
// This queue serializes heavy jobs by PRIORITY (see policy.ts) and evicts named
// engines before a job runs, so only one heavy model is resident at a time. It
// generalizes the ad-hoc llm.pause()/resume() bracketing that imagegen.ts did
// inline: engines register themselves as evictable, jobs declare what they evict.
//
// SOLID: this file is the thin IO layer (async/await + eviction hooks + state);
// ALL ordering/admission decisions live in the pure policy.ts and are called from
// here. It never imports llm/image/capture — those register through the hooks.

import { AsyncLocalStorage } from 'async_hooks'
import { DEFAULT_POLICY, selectNext, type PolicyConfig, type QueueJob, type Tier } from './policy'

/** An engine that can free its resident memory on demand (and warm back up). */
export interface Evictable {
  /** Free the engine's memory NOW. Awaited before a job that evicts it runs.
   *  MUST be idempotent/safe when the engine is already down (the queue always
   *  calls it for a declared id rather than tracking exact residency, so an engine
   *  that lazily reloaded can't slip through and leave two models resident). */
  evict: () => Promise<void> | void
  /** Clear an eviction block if a later engine fails to evict. This must not
   *  load a model while the failed engine may still hold memory. */
  recover?: () => Promise<void> | void
  /** Warm the engine back up after the evicting job finishes. Called by the queue
   *  in run()'s finally. Make it MODE-AWARE: a 'resident' engine reloads here (low
   *  latency next use); an 'on-demand' engine should NOT reload — just clear any
   *  eviction block so it can lazily load on its own next use (frees RAM meanwhile). */
  warm?: () => Promise<void> | void
}

/** A job to run through the queue. */
export interface QueueRequest {
  tier: Tier
  label: string
  /** Ids of registered evictables to free (if resident) before this job runs. */
  evicts?: string[]
}

// The two standard heavy jobs, defined once instead of spelled out at every
// call site (chat was inlined 4× in ipc.ts). A chat/tool turn evicts a resident
// image server; image generation evicts the resident LLM — they can't co-reside
// on unified memory. Frozen so a caller can't mutate the shared descriptor.
export const CHAT_JOB: QueueRequest = Object.freeze({ tier: 2, label: 'chat', evicts: ['image'] })
export const IMAGE_JOB: QueueRequest = Object.freeze({ tier: 2, label: 'image', evicts: ['llm'] })

// Background model work (capture distill, replay-vision, secretary/agent passes).
// Tier 3 = lowest priority: runs only when no chat/workspace/image job is running
// OR waiting, and yields the moment one arrives (admission priority — a running
// background job is never killed, but chat is always admitted ahead of it). Evicts
// a resident image server (can't co-reside with the text/vision model it needs).
export const CAPTURE_JOB: QueueRequest = Object.freeze({
  tier: 3,
  label: 'capture',
  evicts: ['image']
})

/** A tier-3 background job with a descriptive label (same tier + eviction policy as
 *  CAPTURE_JOB). Use for the many background LLM passes so they all share ONE
 *  priority + eviction policy instead of each spelling out an inline literal. */
export function backgroundJob(label: string): QueueRequest {
  return { tier: 3, label, evicts: ['image'] }
}

/** Snapshot of what's running + waiting, for a "queued" indicator in the UI. */
export interface QueueState {
  running: { label: string; tier: Tier }[]
  queued: { label: string; tier: Tier }[]
}

interface Waiter {
  job: QueueJob
  request: QueueRequest
  admit: () => void
  reject: (reason: unknown) => void
}

interface RunningEntry {
  job: QueueJob
  /** Ids this job evicted, to re-warm when it finishes. */
  evicted: string[]
}

export class ModalityQueue {
  private running = new Map<string, RunningEntry>()
  private waiting: Waiter[] = []
  private evictables = new Map<string, Evictable>()
  private seqCounter = 0
  private idCounter = 0
  private changeCbs = new Set<(s: QueueState) => void>()

  private cfg: PolicyConfig = { ...DEFAULT_POLICY }
  // Tracks whether the current async context is already executing inside a running
  // job, so a nested run() (sub-work of that job) runs INLINE instead of deadlocking.
  private readonly jobContext = new AsyncLocalStorage<true>()
  /** Master switch. When off, run() executes fn immediately (today's concurrent
   *  behavior) — no serialization, no eviction. */
  private enabled = true

  /** Turn the queue on/off. Off = pre-queue concurrent behavior. */
  setEnabled(on: boolean): void {
    this.enabled = on
  }

  isEnabled(): boolean {
    return this.enabled
  }

  /** Whether a running tier-2 job lets a tier-1 (dictation) job run alongside it. */
  setTier1CoexistsWithTier2(coexists: boolean): void {
    this.cfg.tier1CoexistsWithTier2 = coexists
  }

  /** Register (or replace) an evictable engine by id. Engines register themselves
   *  so the queue never imports them (layering). The queue does NOT track exact
   *  residency — it always calls evict() for a declared id (evict is idempotent),
   *  so an engine that lazily reloaded can't leave two models resident. */
  registerEvictable(id: string, e: Evictable): void {
    this.evictables.set(id, e)
  }

  onChange(cb: (s: QueueState) => void): () => void {
    this.changeCbs.add(cb)
    return () => this.changeCbs.delete(cb)
  }

  getState(): QueueState {
    return {
      running: [...this.running.values()].map((e) => ({ label: e.job.label, tier: e.job.tier })),
      queued: this.waiting.map((w) => ({ label: w.job.label, tier: w.job.tier }))
    }
  }

  private emitChange(): void {
    const s = this.getState()
    for (const cb of this.changeCbs) {
      try {
        cb(s)
      } catch {
        /* a listener must never break the scheduler */
      }
    }
  }

  /**
   * Enqueue a job, wait until the policy admits it, evict what it declares, run
   * `fn`, release the slot, then admit the next waiter. Cooperative: a running
   * job is NEVER killed to make room — admission only gates jobs not yet started.
   */
  async run<T>(request: QueueRequest, fn: () => Promise<T>): Promise<T> {
    if (!this.enabled) return fn()

    // Reentrancy guard: a job started while ALREADY inside a running queued job is
    // sub-work of that job, which already holds a slot. Run it INLINE — re-admitting
    // would deadlock (a nested tier-3 task can never see running.length === 0 while
    // its tier-2 parent holds the slot). This is what makes it safe to wrap every
    // background LLM call in the queue without auditing the whole call graph.
    if (this.jobContext.getStore()) return fn()

    const job: QueueJob = {
      id: `job-${String(++this.idCounter)}`,
      tier: request.tier,
      label: request.label,
      seq: ++this.seqCounter
    }

    // Wait for admission (resolves synchronously if the slot is free right now).
    await new Promise<void>((resolve, reject) => {
      this.waiting.push({ job, request, admit: resolve, reject })
      this.emitChange()
      this.pump()
    })

    try {
      // Mark this async context as "inside a job" so any nested run() short-circuits.
      return await this.jobContext.run(true, fn)
    } finally {
      const entry = this.running.get(job.id)
      this.running.delete(job.id)
      // Re-warm what this job evicted. Each engine's warm() is mode-aware: a
      // 'resident' engine reloads now; an 'on-demand' engine just clears its
      // eviction block and stays down until its own next use.
      for (const id of entry?.evicted ?? []) {
        const e = this.evictables.get(id)
        if (!e?.warm) continue
        try {
          await e.warm()
        } catch (err) {
          console.error(`[ModalityQueue] warm '${id}' failed:`, err)
        }
      }
      this.emitChange()
      this.pump()
    }
  }

  /** Move any admissible waiter into the running set (evicting first). Called
   *  whenever the running set changes. */
  private pump(): void {
    // Admit greedily: tier-1 can coexist with a running tier-2, so more than one
    // waiter may become admissible on a single change.
    for (;;) {
      const runningArr = [...this.running.values()].map((e) => e.job)
      const waitingArr = this.waiting.map((w) => w.job)
      const next = selectNext(runningArr, waitingArr, this.cfg)
      if (!next) return

      const idx = this.waiting.findIndex((w) => w.job.id === next.id)
      if (idx === -1) return // shouldn't happen — selectNext picks from waiting
      const waiter = this.waiting[idx]! // idx !== -1, so present
      this.waiting.splice(idx, 1)
      const entry: RunningEntry = { job: waiter.job, evicted: [] }
      this.running.set(waiter.job.id, entry)

      // Evict what this job declares, THEN admit. Eviction is async IO; we run it
      // in a microtask so pump() itself stays synchronous and the running-set
      // bookkeeping is consistent before any await.
      void this.admitAfterEvict(waiter, entry)
    }
  }

  private async admitAfterEvict(waiter: Waiter, entry: RunningEntry): Promise<void> {
    // Always evict every declared id (evict is idempotent when the engine is down),
    // so an engine that lazily reloaded is still freed. Record them for re-warm.
    for (const id of waiter.request.evicts ?? []) {
      const e = this.evictables.get(id)
      if (!e) continue
      try {
        await e.evict()
        entry.evicted.push(id)
      } catch (err) {
        console.error(`[ModalityQueue] evict '${id}' failed:`, err)
        // An evictor can fail after it has set its pause block. Clear that block
        // and those of earlier evictions without loading any model into memory.
        for (const recoveryId of [id, ...[...entry.evicted].reverse()]) {
          try {
            await this.evictables.get(recoveryId)?.recover?.()
          } catch (recoverError) {
            console.error(`[ModalityQueue] recover '${recoveryId}' failed:`, recoverError)
          }
        }
        // Do not start a competing heavy model while eviction may be incomplete.
        this.running.delete(waiter.job.id)
        this.emitChange()
        waiter.reject(err)
        this.pump()
        return
      }
    }
    this.emitChange()
    waiter.admit()
  }
}

/** The one process-wide queue. Engines register into it; callers wrap heavy work. */
export const modalityQueue = new ModalityQueue()
