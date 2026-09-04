/**
 * The actions runtime composition, on a real DB with only its true
 * boundaries mocked: electron (paths) and the native helper (the OS). Covers
 * what the pure suites cannot: the device rail guard, run/waitForOutcome
 * through the shared application, and the approval-hook probe. This measures
 * the wiring the app ships instead of a deleted Desktop worker.
 */
import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createUseApplication, type UseApplication } from '@offgrid/use'
import { hasHook, HOOKS, registerHook, unregisterHook } from '../bootstrap/hookRegistry'
import {
  buildHandlers,
  chatActionResultFromTerminalOutcome,
  createDesktopUsePorts,
  observeActionOutcome
} from '../actions/use-runtime'

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ogad-use-runtime-'))
// process.env is shared across files in a worker: set the profile override in
// beforeAll and RESTORE it in afterAll, or every later dbtest in this worker
// opens (and fails on) this file's deleted temp profile.
const originalUserData = process.env.OFFGRID_USER_DATA

beforeAll(() => {
  process.env.OFFGRID_USER_DATA = tempDir
})

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getPath: () => tempDir,
    getAppPath: () => tempDir
  }
}))

// The OS boundary: reminders land in memory; lists read them back; deletes
// remove by the id the create returned (the undo path).
const landed: Array<{ id: string; title: string }> = []
let created = 0
let application: UseApplication
vi.mock('../actions/native-helper', () => ({
  runNativeAction: vi.fn(async (cmd: { command: string; args: Record<string, unknown> }) => {
    if (cmd.command === 'reminders.create') {
      const item = { id: `rt${++created}`, title: String(cmd.args.title) }
      landed.push(item)
      return { ok: true, result: { id: item.id } }
    }
    if (cmd.command === 'reminders.list') {
      return { ok: true, result: { reminders: landed.map(({ title }) => ({ title })) } }
    }
    if (cmd.command === 'reminders.delete') {
      const index = landed.findIndex((item) => item.id === cmd.args.id)
      if (index === -1) {
        return { ok: false, error: `no reminder with id ${String(cmd.args.id)}` }
      }
      landed.splice(index, 1)
      return { ok: true, result: { deleted: cmd.args.id } }
    }
    return { ok: false, error: `unhandled ${cmd.command}` }
  })
}))

beforeAll(() => {
  application = createUseApplication(createDesktopUsePorts())
})

afterAll(async () => {
  await application.stop()
  if (originalUserData === undefined) {
    delete process.env.OFFGRID_USER_DATA
  } else {
    process.env.OFFGRID_USER_DATA = originalUserData
  }
  fs.rmSync(tempDir, { recursive: true, force: true })
})

describe('the shared Use application with Desktop ports', () => {
  it('drives a real action end to end', async () => {
    // The renderer feed: onOutcome fans out every outcome enriched with
    // whether the handler can reverse it - a reminder with an effect id can.
    const fanned: Array<{ id: string; undoable: boolean }> = []
    const offOutcome = application.events((event) => {
      if (event.type === 'action_outcome') {
        fanned.push({ id: event.outcome.id, undoable: event.undoable })
      }
    })

    const proposed = await application.run({
      proposal: {
        type: 'reminder',
        intent: 'remind me to send the deck',
        args: { title: 'Send the deck' },
        risk: 'mutate'
      },
      source: 'chat'
    })
    expect(proposed.accepted).toBe(true)
    if (!proposed.accepted) {
      return
    }
    const outcome = await application.waitForOutcome(proposed.id, 10_000)
    expect(outcome?.outcome).toBe('done')
    expect(landed.map(({ title }) => title)).toEqual(['Send the deck'])
    expect(fanned).toEqual([{ id: proposed.id, undoable: true }])
    offOutcome()

    // Approval UX v2: the reminder auto-ran (reversible), its effect id is
    // stamped, and undo deletes exactly that item through the capability.
    if (outcome && outcome.outcome === 'done') {
      expect(outcome.record.effectId).toBe('rt1')
      const undone = await application.undo(outcome.id)
      expect(undone).toEqual({ ok: true })
      expect(landed).toEqual([])
    }
  })

  it('waitForOutcome times out to undefined for an unknown action', async () => {
    const outcome = await application.waitForOutcome('act_ghost', 50)
    expect(outcome).toBeUndefined()
  })

  it('projects a terminal Chat-owned action through the Pro observation hook', async () => {
    const observed: unknown[] = []
    const observer = (result: unknown): void => {
      observed.push(result)
    }
    registerHook(HOOKS.actionsObserveChatActionResult, observer)
    try {
      observeActionOutcome({
        id: 'act_connector_1',
        outcome: 'done',
        record: {
          id: 'act_connector_1',
          type: 'connector',
          intent: 'create_external_task via APP-143 guarded connector',
          args: {},
          risk: 'mutate',
          source: 'chat',
          sourceRef: 'approval-chat-143',
          payloadHash: 'a'.repeat(64),
          idempotencyKey: 'app143',
          rail: 'connector',
          attempts: 1,
          attemptLog: [
            {
              rail: 'connector',
              at: 1,
              outcome: 'ok',
              detail: 'Created external task "Ship guarded approval journey" in Desktop P0'
            }
          ],
          state: 'done',
          createdAt: 1,
          updatedAt: 2
        }
      })
    } finally {
      unregisterHook(HOOKS.actionsObserveChatActionResult, observer)
    }

    expect(observed).toEqual([
      {
        actionId: 'act_connector_1',
        conversationId: 'approval-chat-143',
        status: 'done',
        summary: 'Created external task "Ship guarded approval journey" in Desktop P0'
      }
    ])
  })

  it('contains a failing result observer after the action commits and exposes the saved result', async () => {
    const observer = async (): Promise<never> => {
      throw new Error('projection database unavailable')
    }
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    registerHook(HOOKS.actionsObserveChatActionResult, observer)
    const stopObserving = application.events((event) => {
      if (event.type === 'action_outcome') observeActionOutcome(event.outcome)
    })
    try {
      const proposed = await application.run({
        proposal: {
          type: 'reminder',
          intent: 'save the observer isolation proof',
          args: { title: 'Observer isolation proof' },
          risk: 'mutate'
        },
        source: 'chat',
        sourceRef: 'approval-chat-observer-failure'
      })
      expect(proposed.accepted).toBe(true)
      if (!proposed.accepted) return

      const outcome = await application.waitForOutcome(proposed.id, 10_000)
      expect(outcome?.outcome).toBe('done')
      expect(landed.some(({ title }) => title === 'Observer isolation proof')).toBe(true)
      await vi.waitFor(() => {
        expect(logged).toHaveBeenCalledWith(
          '[actions] Chat action result projection failed',
          expect.objectContaining({ message: 'projection database unavailable' })
        )
      })
      const terminal = await application.terminalChatOutcomes()
      expect(terminal.map(chatActionResultFromTerminalOutcome)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            actionId: proposed.id,
            conversationId: 'approval-chat-observer-failure',
            status: 'done'
          })
        ])
      )
    } finally {
      stopObserving()
      unregisterHook(HOOKS.actionsObserveChatActionResult, observer)
      logged.mockRestore()
    }
  })

  it('the browser rail is registered: a web_use proposal routes to browser', async () => {
    // The runtime knows web_use through the handlers supplied to the shared
    // Use application, so a proposal is accepted rather than refused as unknown.
    // The future trigger keeps the live display boundary dormant. This asserts
    // registration and acceptance; browser-rail.test.ts proves rail execution.
    const proposed = await application.run({
      proposal: {
        type: 'web_use',
        intent: 'check in for my flight',
        args: { goal: 'check in' },
        risk: 'mutate',
        triggerAt: Date.now() + 60_000
      },
      source: 'chat'
    })
    expect(proposed.accepted).toBe(true)
    // Handler composition is the current Desktop adapter seam. It proves the
    // browser and vision declarations without reaching into a deleted registry.
    const stubRun = (async () => ({ ok: true as const, result: {} })) as never
    const handlers = buildHandlers(stubRun)
    expect(handlers.find(({ type }) => type === 'web_use')?.rail).toBe('browser')
    expect(handlers.find(({ type }) => type === 'computer_use')?.rail).toBe('vision')
  })

  it('the vision rail is registered: a computer_use proposes and routes to vision', async () => {
    const proposed = await application.run({
      proposal: {
        type: 'computer_use',
        intent: 'share the deck over WhatsApp',
        args: { goal: 'share the deck' },
        risk: 'mutate',
        triggerAt: Date.now() + 60_000
      },
      source: 'chat'
    })
    // Accepted because the type is known; its future trigger keeps display actuation dormant.
    expect(proposed.accepted).toBe(true)
  })

  it('detects both approval hook registrations', async () => {
    expect(hasHook(HOOKS.actionsProposeApproval)).toBe(false)
    registerHook(HOOKS.actionsProposeApproval, () => true)
    expect(hasHook(HOOKS.actionsProposeApproval)).toBe(true)
    unregisterHook(HOOKS.actionsProposeApproval)
    registerHook(HOOKS.legacyMcpProposeApproval, () => true)
    expect(hasHook(HOOKS.legacyMcpProposeApproval)).toBe(true)
    unregisterHook(HOOKS.legacyMcpProposeApproval)
  })
})
