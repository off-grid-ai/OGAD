/**
 * Box 11's done-when: the real engine on a real DB, gated through the real
 * hook registry via the gate host. Proves approve runs exactly the approved
 * payload (binding held end to end), reject lands the Action in rejected
 * with the device never fired, and an edit re-binds before running.
 */
import fs from 'fs'
import os from 'os'
import path from 'path'
import Database from 'better-sqlite3-multiple-ciphers'
import { afterEach, describe, expect, it } from 'vitest'
import { HandlerRegistry, UseEngine, type ActionRecord } from '@offgrid/use'
import { makeUseDriver } from '../actions/use-driver'
import { gateHost, resolveActionGate } from '../actions/gate-host'
import { HOOKS, registerHook, unregisterHook } from '../bootstrap/hookRegistry'

const tempDirs: string[] = []
const openDbs: Database.Database[] = []

afterEach(() => {
  unregisterHook(HOOKS.actionsProposeApproval)
  for (const db of openDbs.splice(0)) {
    try {
      db.close()
    } catch {
      /* closed */
    }
  }
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

function makeWorld() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ogad-gate-host-'))
  tempDirs.push(dir)
  const db = new Database(path.join(dir, 'app.db'))
  openDbs.push(db)
  db.exec(`CREATE TABLE test_computer_tasks (title TEXT NOT NULL)`)

  const registry = new HandlerRegistry()
  registry.register({
    type: 'computer_task',
    rail: 'vision',
    defaultRisk: 'mutate',
    verification: 'read_back',
    verify: async (action) => {
      const row = db
        .prepare(`SELECT COUNT(*) AS n FROM test_computer_tasks WHERE title = ?`)
        .get(String(action.args.title)) as { n: number }
      return row.n > 0
    }
  })

  const executed: Record<string, unknown>[] = []
  const device = {
    async execute(action: ActionRecord) {
      executed.push({ ...action.args })
      db.prepare(`INSERT INTO test_computer_tasks (title) VALUES (?)`).run(
        String(action.args.title)
      )
      return { ok: true }
    }
  }

  const clock = { t: 1_000_000 }
  let n = 0
  const engine = new UseEngine({
    driver: makeUseDriver(db),
    registry,
    device,
    gate: gateHost,
    now: () => clock.t,
    newId: () => `act_${++n}`,
    attemptTimeoutMs: 500,
    visibilityMs: 60_000
  })
  return { engine, executed, db }
}

/** Wait until the approval hook has captured the request for an id. */
async function until(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !condition(); i++) {
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  expect(condition()).toBe(true)
}

/** Narrow a tick outcome to the record-carrying variants, or fail the test. */
function recordOutcome(result: Awaited<ReturnType<UseEngine['tick']>>) {
  if (!result || result.outcome === 'poisoned') {
    throw new Error(`unexpected tick outcome: ${JSON.stringify(result)}`)
  }
  return result
}

/** The captured approval request at an index, or fail the test. */
function requestAt(requests: Record<string, unknown>[], index: number): Record<string, unknown> {
  const request = requests[index]
  if (!request) {
    throw new Error(`no approval request captured at index ${index}`)
  }
  return request
}

const proposal = {
  type: 'computer_task',
  intent: 'open the deck on my desktop',
  args: { title: 'Open the deck' },
  risk: 'mutate'
}

describe('the engine gated through the real approval seam', () => {
  it('approve runs exactly the approved payload', async () => {
    const { engine, executed } = makeWorld()
    await engine.init()
    const requests: Record<string, unknown>[] = []
    registerHook(HOOKS.actionsProposeApproval, (req: Record<string, unknown>) => {
      requests.push(req)
      return true
    })

    await engine.propose(proposal, { source: 'chat' })
    const running = engine.tick()
    await until(() => requests.length === 1)

    const request = requestAt(requests, 0)
    expect(request).toMatchObject({
      kind: 'computer',
      risk: 'mutate',
      actionType: 'computer_task',
      args: { title: 'Open the deck' }
    })
    resolveActionGate(String(request.actionId), { kind: 'approve' })

    const result = recordOutcome(await running)
    expect(result.outcome).toBe('done')
    expect(executed).toEqual([{ title: 'Open the deck' }])
    // The payload that ran is the payload the card showed, byte for byte.
    expect(result.record.payloadHash).toBe(request.payloadHash)
  })

  it('reject lands the Action in rejected and the device never fires', async () => {
    const { engine, executed } = makeWorld()
    await engine.init()
    const requests: Record<string, unknown>[] = []
    registerHook(HOOKS.actionsProposeApproval, (req: Record<string, unknown>) => {
      requests.push(req)
      return true
    })

    await engine.propose(proposal, { source: 'chat' })
    const running = engine.tick()
    await until(() => requests.length === 1)
    resolveActionGate(String(requestAt(requests, 0).actionId), {
      kind: 'reject',
      reason: 'not now'
    })

    const result = recordOutcome(await running)
    expect(result.outcome).toBe('rejected')
    expect(result.record.state).toBe('rejected')
    expect(executed).toEqual([])
  })

  it('an edit at the card re-binds and the edited payload is what runs', async () => {
    const { engine, executed } = makeWorld()
    await engine.init()
    const requests: Record<string, unknown>[] = []
    registerHook(HOOKS.actionsProposeApproval, (req: Record<string, unknown>) => {
      requests.push(req)
      return true
    })

    await engine.propose(proposal, { source: 'chat' })
    const first = engine.tick()
    await until(() => requests.length === 1)
    resolveActionGate(String(requestAt(requests, 0).actionId), {
      kind: 'edit',
      args: { title: 'Send the v2 deck' }
    })
    expect((await first)?.outcome).toBe('edited')

    // The edited record re-gates on the next tick, with a new hash.
    const second = engine.tick()
    await until(() => requests.length === 2)
    const regated = requestAt(requests, 1)
    expect(regated.payloadHash).not.toBe(requestAt(requests, 0).payloadHash)
    expect(regated.args).toEqual({ title: 'Send the v2 deck' })
    resolveActionGate(String(regated.actionId), { kind: 'approve' })

    const result = await second
    expect(result?.outcome).toBe('done')
    expect(executed).toEqual([{ title: 'Send the v2 deck' }])
  })

  it('free build (no hook registered): the mutation runs and verifies, unchanged behaviour', async () => {
    const { engine, executed } = makeWorld()
    await engine.init()
    await engine.propose(proposal, { source: 'chat' })
    const result = await engine.tick()
    expect(result?.outcome).toBe('done')
    expect(executed).toEqual([{ title: 'Open the deck' }])
  })
})
