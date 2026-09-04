/**
 * Shared Use application scheduling against a real queue database. The database,
 * device, gate, clock scheduler, and park notifications are platform boundaries;
 * the drain loop, waiters, event feed, and lifecycle remain real Off Grid code.
 */
import fs from 'fs'
import os from 'os'
import path from 'path'
import Database from 'better-sqlite3-multiple-ciphers'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createUseApplication,
  type GateCallback,
  type UseApplication,
  type UseParkPort
} from '@offgrid/use'
import { makeUseDriver } from '../use-driver'

const applications: UseApplication[] = []
const databases: Database.Database[] = []
const tempDirs: string[] = []

interface ParkBoundary {
  park: UseParkPort
  fire(actionId: string): void
}

afterEach(async () => {
  await Promise.all(applications.splice(0).map((application) => application.stop()))
  for (const database of databases.splice(0)) database.close()
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

function makeParkBoundary(): ParkBoundary {
  const listeners = new Set<() => void>()
  const actionListeners = new Map<string, Set<() => void>>()
  const park: UseParkPort = {
    onParked(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    onActionParked(actionId, listener) {
      const current = actionListeners.get(actionId) ?? new Set()
      current.add(listener)
      actionListeners.set(actionId, current)
      return () => current.delete(listener)
    }
  }
  return {
    park,
    fire(actionId: string) {
      for (const listener of actionListeners.get(actionId) ?? []) listener()
      for (const listener of listeners) listener()
    }
  }
}

function makeApplication(
  options: {
    gate?: GateCallback
    park?: UseParkPort
    execute?: () => Promise<{ ok: boolean; detail?: string }>
  } = {}
): UseApplication {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ogad-use-application-'))
  const database = new Database(path.join(dir, 'app.db'))
  tempDirs.push(dir)
  databases.push(database)
  let nextId = 0
  const application = createUseApplication({
    driver: makeUseDriver(database),
    handlers: [
      {
        type: 'message',
        rail: 'semantic',
        defaultRisk: 'mutate',
        verification: 'none_fuzzy'
      }
    ],
    gate: options.gate ?? (async () => ({ kind: 'approve' })),
    device: {
      execute: options.execute ?? (async () => ({ ok: true }))
    },
    park: options.park,
    scheduler: {
      every: (intervalMs, listener) => {
        const timer = setInterval(listener, intervalMs)
        timer.unref()
        return () => clearInterval(timer)
      },
      after: (delayMs, listener) => {
        const timer = setTimeout(listener, delayMs)
        timer.unref()
        return () => clearTimeout(timer)
      }
    },
    newId: () => `action-${++nextId}`,
    attemptTimeoutMs: 1_000
  })
  applications.push(application)
  return application
}

async function propose(application: UseApplication, intent: string): Promise<string> {
  const outcome = await application.run({
    proposal: { type: 'message', intent, args: {}, risk: 'mutate' },
    source: 'chat'
  })
  expect(outcome.accepted).toBe(true)
  if (!outcome.accepted) throw new Error(outcome.reason)
  return outcome.id
}

describe('the shared Use application drain loop', () => {
  it('drains outcomes to their waiters and stops when nothing is due', async () => {
    const application = makeApplication()
    const first = await propose(application, 'first action')
    const second = await propose(application, 'second action')

    expect((await application.waitForOutcome(first, 1_000))?.id).toBe(first)
    expect((await application.waitForOutcome(second, 1_000))?.id).toBe(second)
    await vi.waitFor(() => expect(application.snapshot().running).toBe(false))
  })

  it('a parked action does not block the queue, and its outcome still lands later', async () => {
    const boundary = makeParkBoundary()
    let resolveParked: (() => void) | undefined
    const application = makeApplication({
      park: boundary.park,
      gate: async ({ action }) => {
        if (action.intent !== 'parked action') return { kind: 'approve' }
        await new Promise<void>((resolve) => {
          resolveParked = resolve
          queueMicrotask(() => boundary.fire(action.id))
        })
        return { kind: 'approve' }
      }
    })
    const parked = await propose(application, 'parked action')
    const quick = await propose(application, 'quick action')

    expect((await application.waitForOutcome(quick, 1_000))?.id).toBe(quick)
    resolveParked?.()
    expect((await application.waitForOutcome(parked, 1_000))?.id).toBe(parked)
  })

  it('waitForOutcome returns undefined when its timeout expires', async () => {
    const application = makeApplication()
    await expect(application.waitForOutcome('ghost', 20)).resolves.toBeUndefined()
  })

  it('kick while draining does not start a second drain', async () => {
    let executions = 0
    let release: (() => void) | undefined
    const application = makeApplication({
      execute: async () => {
        executions += 1
        await new Promise<void>((resolve) => {
          release = resolve
        })
        return { ok: true }
      }
    })
    const actionId = await propose(application, 'slow action')
    application.kick()
    application.kick()
    application.kick()

    await vi.waitFor(() => expect(executions).toBe(1))
    release?.()
    expect((await application.waitForOutcome(actionId, 1_000))?.id).toBe(actionId)
    await vi.waitFor(() => expect(application.snapshot().running).toBe(false))
  })
})

describe('Use action outcomes (the UI feed)', () => {
  it('every outcome reaches subscribers, and unsubscribe stops the feed', async () => {
    const application = makeApplication()
    const seen: string[] = []
    const unsubscribe = application.events((event) => {
      if (event.type === 'action_outcome') seen.push(event.outcome.id)
    })
    const first = await propose(application, 'first visible action')
    const second = await propose(application, 'second visible action')
    await application.waitForOutcome(first, 1_000)
    await application.waitForOutcome(second, 1_000)
    expect(seen).toEqual([first, second])

    unsubscribe()
    const third = await propose(application, 'hidden after unsubscribe')
    await application.waitForOutcome(third, 1_000)
    expect(seen).toEqual([first, second])
  })
})
