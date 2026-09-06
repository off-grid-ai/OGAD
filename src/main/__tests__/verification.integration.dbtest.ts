/**
 * Box 14's done-when: a failed read-back drives the retry policy correctly,
 * proven on the real Use application + real DB + the real handlers the app ships,
 * with only the helper boundary scripted. The same
 * scripted helper serves both the rail (create) and the verifiers (list),
 * exactly as production shares runNativeAction.
 */
import fs from 'fs'
import os from 'os'
import path from 'path'
import Database from 'better-sqlite3-multiple-ciphers'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createUseApplication,
  type ActionProposal,
  type ActionRecord,
  type Rail,
  type UseApplication
} from '@offgrid/use'
import { makeUseDriver } from '../actions/use-driver'
import { makeSemanticRailExecutor } from '../actions/semantic-rail'
import { buildHandlers } from '../actions/use-runtime'
import type { NativeActionCommand, NativeActionResponse } from '../actions/native-helper-logic'

const tempDirs: string[] = []
const openDbs: Database.Database[] = []
const applications: UseApplication[] = []

interface VerificationWorld {
  application: UseApplication
  landed: string[]
  creates(): number
}

afterEach(async () => {
  await Promise.all(applications.splice(0).map((application) => application.stop()))
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
function makeWorld({ dropFirstCreates = 0 } = {}): VerificationWorld {
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
  const application = createUseApplication({
    driver: makeUseDriver(db),
    handlers: buildHandlers(run),
    device: {
      async execute(action: ActionRecord, rail: Rail) {
        if (rail !== 'semantic') {
          return { ok: false, detail: 'wrong rail' }
        }
        return semanticExecute(action)
      }
    },
    gate: async () => ({ kind: 'approve' as const }),
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
    now: () => clock.t,
    newId: () => `act_${++n}`,
    attemptTimeoutMs: 500,
    visibilityMs: 60_000
  })
  applications.push(application)
  return { application, landed, creates: () => creates }
}

const proposal: ActionProposal = {
  type: 'reminder',
  intent: 'remind me to send the deck',
  args: { title: 'Send the deck' },
  risk: 'mutate'
}

describe('read-back verification driving the retry policy (real Use application, real DB)', () => {
  it('a clean create verifies by read-back and is done in one attempt', async () => {
    const { application, landed, creates } = makeWorld()
    const proposed = await application.run({ proposal, source: 'chat' })
    expect(proposed.accepted).toBe(true)
    if (!proposed.accepted) return
    const result = await application.waitForOutcome(proposed.id, 1_000)
    expect(result?.outcome).toBe('done')
    expect(landed).toEqual(['Send the deck'])
    expect(creates()).toBe(1)
  })

  it('a false-ok create is caught by read-back and retried exactly once to success', async () => {
    const { application, landed, creates } = makeWorld({ dropFirstCreates: 1 })
    const proposed = await application.run({ proposal, source: 'chat' })
    expect(proposed.accepted).toBe(true)
    if (!proposed.accepted) return
    const result = await application.waitForOutcome(proposed.id, 1_000)
    expect(result?.outcome).toBe('done')
    expect(creates()).toBe(2)
    expect(landed).toEqual(['Send the deck'])
    if (result && result.outcome !== 'poisoned') {
      expect(result.record.attempts).toBe(2)
      expect(result.record.attemptLog.map((a) => a.outcome)).toEqual(['ok', 'ok'])
    }
  })

  it('a write that never lands exhausts retry-once and asks instead of looping', async () => {
    const { application, landed, creates } = makeWorld({ dropFirstCreates: 99 })
    const proposed = await application.run({ proposal, source: 'chat' })
    expect(proposed.accepted).toBe(true)
    if (!proposed.accepted) return
    const result = await application.waitForOutcome(proposed.id, 1_000)
    expect(result?.outcome).toBe('needs_help')
    expect(creates()).toBe(2)
    expect(landed).toEqual([])
  })
})
