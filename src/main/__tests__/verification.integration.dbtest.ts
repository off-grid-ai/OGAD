/**
 * Box 14's done-when: a failed read-back drives the retry policy correctly,
 * proven on the real engine + real DB + the REAL registry the app ships
 * (buildRegistry), with only the helper boundary scripted. The same
 * scripted helper serves both the rail (create) and the verifiers (list),
 * exactly as production shares runNativeAction.
 */
import fs from 'fs'
import os from 'os'
import path from 'path'
import Database from 'better-sqlite3-multiple-ciphers'
import { afterEach, describe, expect, it } from 'vitest'
import { UseEngine, type ActionRecord, type Rail } from '@offgrid/use'
import { makeUseDriver } from '../actions/use-driver'
import { makeSemanticRailExecutor } from '../actions/semantic-rail'
import { buildRegistry } from '../actions/use-runtime'
import type { NativeActionCommand, NativeActionResponse } from '../actions/native-helper-logic'

const tempDirs: string[] = []
const openDbs: Database.Database[] = []

afterEach(() => {
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

/**
 * A scripted Reminders world: creates succeed or silently drop (the classic
 * false-ok), lists report what actually landed.
 */
function makeWorld({ dropFirstCreates = 0 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ogad-verify-'))
  tempDirs.push(dir)
  const db = new Database(path.join(dir, 'app.db'))
  openDbs.push(db)

  const landed: string[] = []
  let drops = dropFirstCreates
  let creates = 0
  const run = async (cmd: NativeActionCommand): Promise<NativeActionResponse> => {
    if (cmd.command === 'reminders.create') {
      creates += 1
      if (drops > 0) {
        drops -= 1
        return { ok: true, result: { id: 'ghost' } } // claims ok, never lands
      }
      landed.push(String(cmd.args.title))
      return { ok: true, result: { id: `r${creates}` } }
    }
    if (cmd.command === 'reminders.list') {
      return { ok: true, result: { reminders: landed.map((title) => ({ title })) } }
    }
    return { ok: false, error: `unexpected command ${cmd.command}` }
  }

  const semanticExecute = makeSemanticRailExecutor(run)
  const clock = { t: 1_000_000 }
  let n = 0
  const engine = new UseEngine({
    driver: makeUseDriver(db),
    registry: buildRegistry(run),
    device: {
      async execute(action: ActionRecord, rail: Rail) {
        if (rail !== 'semantic') {
          return { ok: false, detail: 'wrong rail' }
        }
        return semanticExecute(action)
      }
    },
    gate: async () => ({ kind: 'approve' as const }),
    now: () => clock.t,
    newId: () => `act_${++n}`,
    attemptTimeoutMs: 500,
    visibilityMs: 60_000
  })
  return { engine, landed, creates: () => creates }
}

const proposal = {
  type: 'reminder',
  intent: 'remind me to send the deck',
  args: { title: 'Send the deck' },
  risk: 'mutate'
}

describe('read-back verification driving the retry policy (real registry, real DB)', () => {
  it('a clean create verifies by read-back and is done in one attempt', async () => {
    const { engine, landed, creates } = makeWorld()
    await engine.init()
    await engine.propose(proposal, { source: 'chat' })
    const result = await engine.tick()
    expect(result?.outcome).toBe('done')
    expect(landed).toEqual(['Send the deck'])
    expect(creates()).toBe(1)
  })

  it('a false-ok create is caught by read-back and retried exactly once to success', async () => {
    const { engine, landed, creates } = makeWorld({ dropFirstCreates: 1 })
    await engine.init()
    await engine.propose(proposal, { source: 'chat' })
    const result = await engine.tick()
    expect(result?.outcome).toBe('done')
    expect(creates()).toBe(2)
    expect(landed).toEqual(['Send the deck'])
    if (result && result.outcome !== 'poisoned') {
      expect(result.record.attempts).toBe(2)
      expect(result.record.attemptLog.map((a) => a.outcome)).toEqual(['ok', 'ok'])
    }
  })

  it('a write that never lands exhausts retry-once and asks instead of looping', async () => {
    const { engine, landed, creates } = makeWorld({ dropFirstCreates: 99 })
    await engine.init()
    await engine.propose(proposal, { source: 'chat' })
    const result = await engine.tick()
    expect(result?.outcome).toBe('needs_help')
    expect(creates()).toBe(2)
    expect(landed).toEqual([])
  })
})
