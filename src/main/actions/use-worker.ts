/**
 * The action worker - drains the engine's queue and routes each outcome to
 * whoever is waiting on it (R1 box 13).
 *
 * A tick that reaches the gate holds its promise open until a human
 * decides, so the drain loop cannot simply await every tick: it races each
 * tick against the park signal, and when a tick parks it is left running in
 * the background (its outcome still lands with waiters when the human
 * eventually resolves the gate) while the loop moves on to the next due
 * message. The queue's lease keeps concurrent in-flight ticks safe.
 *
 * Pure orchestration over two injected ports (an engine-shaped tick and the
 * park signal), so it is testable with scripted fakes; use-runtime.ts wires
 * the real UseEngine and gate host.
 */
import type { TickOutcome } from '@offgrid/use'

export interface EngineLike {
  tick(): Promise<TickOutcome | undefined>
}

export interface ParkSignal {
  /** Subscribe to "an action just parked at the gate"; returns unsubscribe. */
  onParked(listener: () => void): () => void
}

export interface ActionWorker {
  /** Start (or continue) draining until the queue reports nothing due. */
  kick(): void
  /** The outcome for one action id, or undefined when the wait times out
   *  (parked at the gate, or scheduled for later). */
  waitForOutcome(actionId: string, timeoutMs: number): Promise<TickOutcome | undefined>
  /** Whether a drain pass is currently running (health surface, tests). */
  draining(): boolean
}

export function createActionWorker(engine: EngineLike, park: ParkSignal): ActionWorker {
  const waiters = new Map<string, Array<(outcome: TickOutcome) => void>>()
  let running = false

  const notify = (outcome: TickOutcome) => {
    const list = waiters.get(outcome.id)
    if (list) {
      waiters.delete(outcome.id)
      for (const resolve of list) {
        resolve(outcome)
      }
    }
  }

  const drain = async () => {
    running = true
    try {
      for (;;) {
        let parkedResolve: (() => void) | undefined
        const parked = new Promise<'parked'>((resolve) => {
          parkedResolve = () => resolve('parked')
        })
        const unsubscribe = park.onParked(() => parkedResolve?.())
        const tickPromise = engine.tick()
        try {
          const first = await Promise.race([
            tickPromise.then((outcome) => ({ kind: 'tick' as const, outcome })),
            parked.then(() => ({ kind: 'parked' as const }))
          ])
          if (first.kind === 'parked') {
            // The tick is waiting on a human. Leave it in flight - its
            // outcome still reaches waiters when the gate resolves - and
            // move on to the next due message.
            void tickPromise.then((outcome) => outcome && notify(outcome))
            continue
          }
          if (!first.outcome) {
            return // nothing due
          }
          notify(first.outcome)
        } finally {
          unsubscribe()
        }
      }
    } finally {
      running = false
    }
  }

  return {
    kick() {
      if (!running) {
        void drain()
      }
    },
    draining() {
      return running
    },
    waitForOutcome(actionId, timeoutMs) {
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          const list = waiters.get(actionId)
          if (list) {
            waiters.set(
              actionId,
              list.filter((w) => w !== wrapped)
            )
          }
          resolve(undefined)
        }, timeoutMs)
        const wrapped = (outcome: TickOutcome) => {
          clearTimeout(timer)
          resolve(outcome)
        }
        const list = waiters.get(actionId) ?? []
        list.push(wrapped)
        waiters.set(actionId, list)
      })
    }
  }
}
