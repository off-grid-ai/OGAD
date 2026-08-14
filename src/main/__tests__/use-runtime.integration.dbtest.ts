/**
 * The actions runtime composition, on a real DB with only its true
 * boundaries mocked: electron (paths) and the native helper (the OS). Covers
 * what the pure suites cannot - the lazy singleton, the device's rail guard,
 * propose/waitForOutcome through the real worker, and the approval-hook
 * probe - so the wiring the app actually ships is measured, not assumed.
 */
import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { HOOKS, registerHook, unregisterHook } from '../bootstrap/hookRegistry'

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ogad-use-runtime-'))
process.env.OFFGRID_USER_DATA = tempDir

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getPath: () => tempDir,
    getAppPath: () => tempDir
  }
}))

// The OS boundary: reminders land in memory; lists read them back.
const landed: string[] = []
vi.mock('../actions/native-helper', () => ({
  runNativeAction: vi.fn(async (cmd: { command: string; args: Record<string, unknown> }) => {
    if (cmd.command === 'reminders.create') {
      landed.push(String(cmd.args.title))
      return { ok: true, result: { id: 'rt1' } }
    }
    if (cmd.command === 'reminders.list') {
      return { ok: true, result: { reminders: landed.map((title) => ({ title })) } }
    }
    return { ok: false, error: `unhandled ${cmd.command}` }
  })
}))

afterAll(() => {
  fs.rmSync(tempDir, { recursive: true, force: true })
})

describe('getActionsRuntime', () => {
  it('composes once (lazy singleton) and drives a real action end to end', async () => {
    const { getActionsRuntime } = await import('../actions/use-runtime')
    const runtime = getActionsRuntime()
    expect(getActionsRuntime()).toBe(runtime)

    const proposed = await runtime.propose(
      {
        type: 'reminder',
        intent: 'remind me to send the deck',
        args: { title: 'Send the deck' },
        risk: 'mutate'
      },
      { source: 'chat' }
    )
    expect(proposed.accepted).toBe(true)
    if (!proposed.accepted) {
      return
    }
    runtime.kick()
    const outcome = await runtime.waitForOutcome(proposed.id, 10_000)
    expect(outcome?.outcome).toBe('done')
    expect(landed).toEqual(['Send the deck'])
  })

  it('waitForOutcome times out to undefined for an unknown action', async () => {
    const { getActionsRuntime } = await import('../actions/use-runtime')
    const outcome = await getActionsRuntime().waitForOutcome('act_ghost', 50)
    expect(outcome).toBeUndefined()
  })

  it('approvalHookActive reflects both hook registrations', async () => {
    const { getActionsRuntime } = await import('../actions/use-runtime')
    const runtime = getActionsRuntime()
    expect(runtime.approvalHookActive()).toBe(false)
    registerHook(HOOKS.actionsProposeApproval, () => true)
    expect(runtime.approvalHookActive()).toBe(true)
    unregisterHook(HOOKS.actionsProposeApproval)
    registerHook(HOOKS.legacyMcpProposeApproval, () => true)
    expect(runtime.approvalHookActive()).toBe(true)
    unregisterHook(HOOKS.legacyMcpProposeApproval)
  })
})
