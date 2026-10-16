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
  evict: (by?: QueueRequest) => Promise<void> | void
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
  /** A background job that foreground work may stop mid-run: its model request is aborted
   *  (`currentSignal`) and the job runs again from the start once the slot is free. Only for
   *  work that is safe to repeat, such as a single model call with no side effects. */
  preemptible?: boolean
}

// The two standard heavy jobs, defined once instead of spelled out at every
// call site (chat was inlined 4× in ipc.ts). A chat/tool turn evicts a resident
// image server; image generation evicts the resident LLM — they can't co-reside
// on unified memory. Frozen so a caller can't mutate the shared descriptor.
export const CHAT_JOB: QueueRequest = Object.freeze({ tier: 2, label: 'chat', evicts: ['image'] })
export const IMAGE_JOB: QueueRequest = Object.freeze({ tier: 2, label: 'image', evicts: ['llm'] })

// Background model work (capture distill, replay-vision, secretary/agent passes).
// Tier 3 = lowest priority: runs only when no chat/workspace/image job is running
// OR waiting. Preemptible: when speech or a chat turn arrives while one is running, its
// model request is aborted and it runs again later, so the person never waits behind it
// (measured 2026-10-15: a 67 s capture pass held a replayed voice reply to 39.8 s before its
// first sound; an aborted request frees llama-server within ~1.6 s). Evicts a resident image
// server (can't co-reside with the text/vision model it needs).
export const CAPTURE_JOB: QueueRequest = Object.freeze({
  tier: 3,
  label: 'capture',
  evicts: ['image'],
  preemptible: true
})

/** Reading a reply aloud. Tier 1 like dictation: it starts at once beside whatever runs, and no
 *  background pass starts while it runs or waits, so the voice is not competing for the GPU. */
export const SPEECH_JOB: QueueRequest = Object.freeze({ tier: 1, label: 'speech' })

/** How long background passes wait after foreground work ends: long enough for a voice reply's
 *  speech request to arrive (the renderer asks for it once the chat turn's last token lands).
 *  Measured 2026-10-15: without it, a capture pass queued behind the chat started the instant the
 *  turn ended, and the reply's speech then took 40-83 s instead of ~2.5 s. */
export const FOREGROUND_GRACE_MS = 3000

/** A tier-3 background job with a descriptive label (same tier + eviction policy as
 *  CAPTURE_JOB). Use for the many background LLM passes so they all share ONE
 *  priority + eviction policy instead of each spelling out an inline literal. */
export function backgroundJob(label: string): QueueRequest {
  return { tier: 3, label, evicts: ['image'], preemptible: true }
}

/** Why a preempted job's model request was aborted. */
export class PreemptedError extends Error {
  constructor(readonly by: string) {
    super(`Stopped to make room for ${by}; it runs again later.`)
    this.name = 'PreemptedError'
  }
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
  /** Stops a preemptible job's model request (see `currentSignal`). */
  controller?: AbortController
  /** Set when foreground work stopped this job: it runs again instead of failing. */
  preempted?: boolean
  startedAt: number
}

/** What a running job's async context carries: the signal that stops a preemptible one. */
interface JobContext {
  readonly signal?: AbortSignal
}

export class ModalityQueue {
  private running = new Map<string, RunningEntry>()
  private waiting: Waiter[] = []
  private evictables = new Map<string, Evictable>()
  private seqCounter = 0
  private idCounter = 0
  private changeCbs = new Set<(s: QueueState) => void>()

  private cfg: PolicyConfig = { ...DEFAULT_POLICY }
  /** Background passes stay waiting until this time (see FOREGROUND_GRACE_MS). */
  private backgroundHeldUntil = 0
  private graceTimer: ReturnType<typeof setTimeout> | null = null
  private readonly foregroundGraceMs: number

  /** `foregroundGraceMs`: how long tier 3 waits after a tier-1/2 job ends. 0 = no wait. */
  constructor(options: { foregroundGraceMs?: number } = {}) {
    this.foregroundGraceMs = options.foregroundGraceMs ?? 0
  }
  // Tracks whether the current async context is already executing inside a running
  // job, so a nested run() (sub-work of that job) runs INLINE instead of deadlocking.
  private readonly jobContext = new AsyncLocalStorage<JobContext>()
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

    // A preempted job waits its turn again and runs from the start.
    for (;;) {
      const attempt = await this.attempt(request, fn)
      if (attempt.done) return attempt.value
    }
  }

  /**
   * The signal that stops the current job's model request when foreground work preempts it.
   * Undefined outside a preemptible job. Model clients read it, so callers need not pass it.
   */
  currentSignal(): AbortSignal | undefined {
    return this.jobContext.getStore()?.signal
  }

  /** One admission and run of `fn`. `done: false` when foreground work preempted it. */
  private async attempt<T>(
    request: QueueRequest,
    fn: () => Promise<T>
  ): Promise<{ done: true; value: T } | { done: false }> {
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

    const entry = this.running.get(job.id)
    try {
      // Mark this async context as "inside a job" so any nested run() short-circuits.
      return {
        done: true,
        value: await this.jobContext.run({ signal: entry?.controller?.signal }, fn)
      }
    } catch (error) {
      if (!entry?.preempted) throw error
      console.warn(
        `[ModalityQueue] preempted '${job.label}' after ${Date.now() - entry.startedAt} ms; it runs again later`
      )
      return { done: false }
    } finally {
      this.running.delete(job.id)
      if (job.tier !== 3) this.holdBackground()
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

  /** Foreground work (speech, a chat turn) is running or waiting: stop the preemptible
   *  background jobs that are running, so their model requests free the GPU now. */
  private preemptBackground(): void {
    const foreground =
      [...this.running.values()].find((e) => e.job.tier < 3)?.job ??
      this.waiting.find((w) => w.job.tier < 3)?.job
    if (!foreground) return
    for (const entry of this.running.values()) {
      if (!entry.controller || entry.preempted) continue
      entry.preempted = true
      entry.controller.abort(new PreemptedError(foreground.label))
    }
  }

  /** Keep tier 3 waiting for the grace period, then look at the waiters again. */
  private holdBackground(): void {
    if (this.foregroundGraceMs <= 0) return
    this.backgroundHeldUntil = Date.now() + this.foregroundGraceMs
    if (this.graceTimer) clearTimeout(this.graceTimer)
    this.graceTimer = setTimeout(() => {
      // The latest hold owns this timer (an earlier one was cleared), so the hold ends here.
      this.graceTimer = null
      this.backgroundHeldUntil = 0
      this.pump()
    }, this.foregroundGraceMs)
    this.graceTimer.unref()
  }

  /** Move any admissible waiter into the running set (evicting first). Called
   *  whenever the running set changes. */
  private pump(): void {
    this.preemptBackground()
    // Admit greedily: tier-1 can coexist with a running tier-2, so more than one
    // waiter may become admissible on a single change.
    for (;;) {
      const runningArr = [...this.running.values()].map((e) => e.job)
      const waitingArr = this.waiting.map((w) => w.job)
      const backgroundHeld = Date.now() < this.backgroundHeldUntil
      const next = selectNext(runningArr, waitingArr, this.cfg, backgroundHeld)
      if (!next) return

      const idx = this.waiting.findIndex((w) => w.job.id === next.id)
      if (idx === -1) return // shouldn't happen — selectNext picks from waiting
      const waiter = this.waiting[idx]! // idx !== -1, so present
      this.waiting.splice(idx, 1)
      const entry: RunningEntry = {
        job: waiter.job,
        evicted: [],
        startedAt: Date.now(),
        ...(waiter.request.preemptible ? { controller: new AbortController() } : {})
      }
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
        await e.evict(waiter.request)
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
export const modalityQueue = new ModalityQueue({ foregroundGraceMs: FOREGROUND_GRACE_MS })
