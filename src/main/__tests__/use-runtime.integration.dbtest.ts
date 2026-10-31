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
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { HOOKS, registerHook, unregisterHook } from '../bootstrap/hookRegistry'
import { installFakeActionsHelper } from './harness/fake-actions-helper'

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ogad-use-runtime-'))
// process.env is shared across files in a worker: set the profile override in
// beforeAll and RESTORE it in afterAll, or every later dbtest in this worker
// opens (and fails on) this file's deleted temp profile.
const originalUserData = process.env.OFFGRID_USER_DATA

beforeAll(() => {
  process.env.OFFGRID_USER_DATA = tempDir
})

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
  app: {
    isPackaged: false,
    getPath: () => tempDir,
    getAppPath: () => tempDir
  }
}))

// The OS boundary: the native actions helper, an executable (harness/fake-actions-helper).
const helper = installFakeActionsHelper(tempDir)
const landed = helper.landed
let restoreCwd: () => void = () => {}
beforeAll(() => {
  restoreCwd = helper.useFrom()
})
afterAll(() => restoreCwd())

afterAll(() => {
  if (originalUserData === undefined) {
    delete process.env.OFFGRID_USER_DATA
  } else {
    process.env.OFFGRID_USER_DATA = originalUserData
  }
  fs.rmSync(tempDir, { recursive: true, force: true })
})

describe('getActionsRuntime', () => {
  it('composes once (lazy singleton) and drives a real action end to end', async () => {
    const { getActionsRuntime } = await import('../actions/use-runtime')
    // This journey supplies the macOS native-helper boundary, regardless of the CI host.
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
    let runtime: ReturnType<typeof getActionsRuntime>
    try {
      Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
      runtime = getActionsRuntime()
    } finally {
      Object.defineProperty(process, 'platform', platform)
    }
    expect(getActionsRuntime()).toBe(runtime)

    // The renderer feed: onOutcome fans out every outcome enriched with
    // whether the handler can reverse it - a reminder with an effect id can.
    const fanned: Array<{ id: string; undoable: boolean }> = []
    const offOutcome = runtime.onOutcome(({ outcome, undoable }) => {
      fanned.push({ id: outcome.id, undoable })
    })

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
    expect(landed().map(({ title }) => title)).toEqual(['Send the deck'])
    expect(fanned).toEqual([{ id: proposed.id, undoable: true }])
    offOutcome()

    // Approval UX v2: the reminder auto-ran (reversible), its effect id is
    // stamped, and undo deletes exactly that item through the capability.
    if (outcome && outcome.outcome === 'done') {
      expect(outcome.record.effectId).toBe('rt1')
      const undone = await runtime.undo(outcome.record)
      expect(undone).toEqual({ ok: true })
      expect(landed()).toEqual([])
    }
  })

  it('waitForOutcome times out to undefined for an unknown action', async () => {
    const { getActionsRuntime } = await import('../actions/use-runtime')
    const outcome = await getActionsRuntime().waitForOutcome('act_ghost', 50)
    expect(outcome).toBeUndefined()
  })

  it('the browser rail is registered: a web_use proposal routes to browser', async () => {
    const { getActionsRuntime } = await import('../actions/use-runtime')
    const { buildRegistry } = await import('../actions/use-runtime')
    // The runtime's registry knows web_use (registerBrowserRail composed in
    // buildRegistry), so a proposal is accepted rather than refused as unknown.
    // Not kicked - the live host needs a display; this asserts registration and
    // acceptance, the rail-routing is proven in browser-rail.test.ts.
    const proposed = await getActionsRuntime().propose(
      {
        type: 'web_use',
        intent: 'check in for my flight',
        args: { goal: 'check in' },
        risk: 'mutate'
      },
      { source: 'chat' }
    )
    expect(proposed.accepted).toBe(true)
    // route() reads only the declared rail, so a stub run suffices here.
    const stubRun = (async () => ({ ok: true as const, result: {} })) as never
    const registry = buildRegistry(stubRun)
    expect(registry.route('web_use')).toBe('browser')
    // The vision rail is composed too: computer_use routes to vision.
    expect(registry.route('computer_use')).toBe('vision')
  })

  it('the vision rail is registered: a computer_use proposes and routes to vision', async () => {
    const { getActionsRuntime } = await import('../actions/use-runtime')
    const proposed = await getActionsRuntime().propose(
      {
        type: 'computer_use',
        intent: 'share the deck over WhatsApp',
        args: { goal: 'share the deck' },
        risk: 'mutate'
      },
      { source: 'chat' }
    )
    // Accepted (the type is known) but not kicked - actuation needs a display.
    expect(proposed.accepted).toBe(true)
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
