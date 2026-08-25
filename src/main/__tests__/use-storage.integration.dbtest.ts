/**
 * Integration tests at the real DB seam: the actual @offgrid/use engine
 * running against a real better-sqlite3 file in a temp dir - no mocks
 * between the engine and SQLite. Fakes exist only at the true boundaries
 * (the device = the OS surface, the gate = a human). The device writes its
 * effect into a table in the SAME database, and the handler verifies by
 * reading it back - one DB as the source of truth, end to end.
 */
import fs from 'fs'
import os from 'os'
import path from 'path'
// The app's own SQLite build (drop-in better-sqlite3 superset); the db suite
// swaps its native ABI to the test runner's node for the run.
import Database from 'better-sqlite3-multiple-ciphers'
import { afterEach, describe, expect, it } from 'vitest'
import { HandlerRegistry, UseEngine, type ActionRecord, type GateDecision } from '@offgrid/use'
import { makeUseDriver } from '../actions/use-driver'

const tempDirs: string[] = []
const openDbs: Database.Database[] = []

afterEach(() => {
  for (const db of openDbs.splice(0)) {
    try {
      db.close()
    } catch {
      /* already closed */
    }
  }
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

function makeAppDb(): { db: Database.Database; dbPath: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ogad-use-storage-'))
  tempDirs.push(dir)
  const dbPath = path.join(dir, 'app.db')
  const db = new Database(dbPath)
  openDbs.push(db)
  // The app's own world: an existing table the engine must coexist with,
  // and the table the semantic rail's effects land in.
  db.exec(`CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT)`)
  db.exec(`CREATE TABLE test_reminders (title TEXT NOT NULL)`)
  db.prepare(`INSERT INTO app_settings (key, value) VALUES (?, ?)`).run('theme', 'dark')
  return { db, dbPath }
}

function makeEngine(
  db: Database.Database,
  clock: { t: number },
  options: { gate?: (record: ActionRecord) => GateDecision; ids?: string } = {}
) {
  const registry = new HandlerRegistry()
  registry.register({
    type: 'reminder',
    rail: 'semantic',
    defaultRisk: 'mutate',
    verification: 'read_back',
    verify: async (action) => {
      const row = db
        .prepare(`SELECT COUNT(*) AS n FROM test_reminders WHERE title = ?`)
        .get(String(action.args.title)) as { n: number }
      return row.n > 0
    }
  })
  const device = {
    calls: 0,
    async execute(action: ActionRecord) {
      device.calls += 1
      db.prepare(`INSERT INTO test_reminders (title) VALUES (?)`).run(String(action.args.title))
      return { ok: true }
    }
  }
  let n = 0
  const engine = new UseEngine({
    driver: makeUseDriver(db),
    registry,
    device,
    gate: async ({ action }) => options.gate?.(action) ?? { kind: 'approve' as const },
    now: () => clock.t,
    newId: () => `${options.ids ?? 'act'}_${++n}`,
    attemptTimeoutMs: 500,
    visibilityMs: 1000
  })
  return { engine, device }
}

const proposal = (title: string, triggerAt?: number) => ({
  type: 'reminder',
  intent: `remind me: ${title}`,
  args: { title },
  risk: 'mutate',
  ...(triggerAt ? { triggerAt } : {})
})

describe('the engine on the app database', () => {
  it('migrates its tables into the app DB and coexists with app tables', async () => {
    const { db } = makeAppDb()
    const clock = { t: 1_000_000 }
    const { engine } = makeEngine(db, clock)
    await engine.init()
    await engine.init() // idempotent

    const tables = db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`)
      .all()
      .map((r) => (r as { name: string }).name)
    expect(tables).toContain('use_queue')
    expect(tables).toContain('app_settings')
    const setting = db.prepare(`SELECT value FROM app_settings WHERE key = 'theme'`).get() as {
      value: string
    }
    expect(setting.value).toBe('dark')
  })

  it('walks a real action end to end: the effect lands in the same DB and read-back verifies it', async () => {
    const { db } = makeAppDb()
    const clock = { t: 1_000_000 }
    const { engine, device } = makeEngine(db, clock)
    await engine.init()

    const proposed = await engine.propose(proposal('Send the deck'), { source: 'chat' })
    expect(proposed.accepted).toBe(true)

    const result = await engine.tick()
    expect(result?.outcome).toBe('done')
    expect(device.calls).toBe(1)
    const rows = db.prepare(`SELECT title FROM test_reminders`).all() as { title: string }[]
    expect(rows.map((r) => r.title)).toEqual(['Send the deck'])
    expect(db.prepare(`SELECT COUNT(*) AS n FROM use_queue`).get()).toEqual({ n: 0 })
  })

  it('a scheduled action survives a full engine restart over the same file', async () => {
    const { db, dbPath } = makeAppDb()
    const clock = { t: 1_000_000 }
    const first = makeEngine(db, clock, { ids: 'a' })
    await first.engine.init()
    await first.engine.propose(proposal('later', clock.t + 60_000), { source: 'schedule' })
    expect(await first.engine.tick()).toBeUndefined()
    db.close() // the app quits

    const reopened = new Database(dbPath)
    openDbs.push(reopened)
    reopened.exec(`CREATE TABLE IF NOT EXISTS test_reminders (title TEXT NOT NULL)`)
    clock.t += 60_000
    const second = makeEngine(reopened, clock, { ids: 'b' })
    await second.engine.init()
    const result = await second.engine.tick()
    expect(result?.outcome).toBe('done')
    const rows = reopened.prepare(`SELECT title FROM test_reminders`).all() as { title: string }[]
    expect(rows.map((r) => r.title)).toEqual(['later'])
  })

  it('a lease held by one engine blocks a second engine on the same DB until it expires', async () => {
    const { db } = makeAppDb()
    const clock = { t: 1_000_000 }
    const a = makeEngine(db, clock, { ids: 'a' })
    const b = makeEngine(db, clock, { ids: 'b' })
    await a.engine.init()
    await a.engine.propose(proposal('exclusive'), { source: 'chat' })

    // Worker A leases the message directly (simulating a worker that died
    // mid-run without completing).
    const leased = await a.engine.queue.receive()
    expect(leased?.id).toBeDefined()

    expect(await b.engine.tick()).toBeUndefined() // blocked by the live lease
    clock.t += 1001 // the dead worker's lease expires
    const result = await b.engine.tick()
    expect(result?.outcome).toBe('done')
    expect(b.device.calls + a.device.calls).toBe(1)
  })

  it('dedup holds across engine instances sharing the DB', async () => {
    const { db } = makeAppDb()
    const clock = { t: 1_000_000 }
    const a = makeEngine(db, clock, { ids: 'a' })
    const b = makeEngine(db, clock, { ids: 'b' })
    await a.engine.init()

    const first = await a.engine.propose(proposal('once'), { source: 'chat' })
    const second = await b.engine.propose(proposal('once'), { source: 'chat' })
    expect(first).toMatchObject({ accepted: true, deduped: false })
    expect(second).toMatchObject({ accepted: true, deduped: true })
    expect(db.prepare(`SELECT COUNT(*) AS n FROM use_queue`).get()).toEqual({ n: 1 })
  })
})
