/**
 * The chat tool's engine path (R1 box 13): a gated mutation becomes a
 * durable Action through the injected actions port, reads stay inline, and
 * a listening pro approval queue keeps the legacy path exactly as before.
 */
import { describe, expect, it, vi } from 'vitest'
import type { TickOutcome } from '@offgrid/use'
import { NativeActionToolExtension, type ActionsPort } from '../nativeActionToolExtension'
import {
  actionTypeForTool,
  NATIVE_TOOL_SPECS,
  TOOL_ACTION_TYPES
} from '../nativeActionToolExtension-logic'

function makePort(
  overrides: Partial<ActionsPort> = {}
): ActionsPort & { proposed: unknown[]; proposalMeta: unknown[] } {
  const proposed: unknown[] = []
  const proposalMeta: unknown[] = []
  return {
    proposed,
    proposalMeta,
    approvalHookActive: () => false,
    async propose(input, meta) {
      proposed.push(input)
      proposalMeta.push(meta)
      return { accepted: true, id: 'act_1', deduped: false }
    },
    async waitForOutcome() {
      return {
        id: 'act_1',
        outcome: 'done',
        record: { attemptLog: [] }
      } as unknown as TickOutcome
    },
    whenParked: () => new Promise<void>(() => {}),
    kick: () => {},
    ...overrides
  }
}

const run = vi.fn(async () => ({ ok: true as const, result: { id: 'r1' } }))
const proposeApproval = vi.fn(() => undefined)
const proEntitled = () => true

// Pin darwin: these assert the full macOS tool set (messages_send, the inline
// reads, etc.). Without it the extension defaults to process.platform, and on
// a Linux CI runner specsForPlatform('linux') is empty - every tool unknown.
const makeExtension = (actions?: ActionsPort): NativeActionToolExtension =>
  new NativeActionToolExtension({ run, proposeApproval, isProEntitled: proEntitled, actions }, 'darwin')

describe('the tool-to-action-type map', () => {
  it('covers exactly the mutating tools', () => {
    expect(Object.keys(TOOL_ACTION_TYPES).sort()).toEqual([
      'calendar_create_event',
      'computer_task',
      'mail_send',
      'messages_send',
      'reminders_create',
      'web_use'
    ])
    expect(actionTypeForTool('reminders_create')).toBe('reminder')
    expect(actionTypeForTool('web_use')).toBe('web_use')
    expect(actionTypeForTool('web_task')).toBe('web_use')
    expect(actionTypeForTool('computer_task')).toBe('computer_task')
    expect(actionTypeForTool('calendar_list_events')).toBeUndefined()
  })
})

describe('the spec table', () => {
  it('every spec produces a title, mapped args, and a formatted result', () => {
    const sample = {
      title: 'x',
      start: 's',
      end: 'e',
      query: 'q',
      to: 't',
      text: 'm',
      url: 'u'
    }
    for (const spec of NATIVE_TOOL_SPECS) {
      expect(typeof spec.title(sample)).toBe('string')
      expect(spec.title(sample).length).toBeGreaterThan(0)
      expect(typeof spec.buildArgs(sample)).toBe('object')
      expect(typeof spec.formatResult({ id: 'r1' })).toBe('string')
    }
    // Only the engine-routed (mutating) specs must format an undefined
    // result - the engine reports outcomes, not helper payloads.
    for (const name of Object.keys(TOOL_ACTION_TYPES)) {
      const spec = NATIVE_TOOL_SPECS.find((s) => s.name === name)
      expect(typeof spec?.formatResult(undefined)).toBe('string')
    }
  })

  it('the extension exposes its schemas and system hint', () => {
    const extension = makeExtension(makePort())
    expect(extension.schemas()).toHaveLength(NATIVE_TOOL_SPECS.length)
    const names = extension.schemas().map(
      (schema) => (schema as { function: { name: string } }).function.name
    )
    expect(names).toContain('web_use')
    expect(names).not.toContain('web_task')
    expect(extension.systemHint()).toMatch(/act on the user's Mac/)
    expect(extension.canHandle('reminders_create')).toBe(true)
  })

  it('accepts a legacy web_task call at the input boundary but proposes canonical web_use', async () => {
    const port = makePort()
    const extension = makeExtension(port)

    await extension.execute('web_task', { goal: 'Check the release page' })

    expect(port.proposed[0]).toMatchObject({ type: 'web_use' })
  })
})

describe('the engine path', () => {
  it('starts the exact Web Use brief selected by the Chat model without a second gate', async () => {
    const port = makePort()
    const extension = new NativeActionToolExtension(
      { run, proposeApproval, isProEntitled: proEntitled, actions: port },
      'darwin'
    )

    await extension.execute(
      'web_use',
      {
        goal: 'Open the release page and stop when version 4.2 is visible.',
        url: 'https://example.test/releases'
      },
      { conversationId: 'chat-release', userQuery: 'Show me version 4.2 on the release page' }
    )

    expect(port.proposed[0]).toMatchObject({
      intent: 'Open the release page and stop when version 4.2 is visible.',
      args: {
        goal: 'Open the release page and stop when version 4.2 is visible.',
        url: 'https://example.test/releases'
      }
    })
  })

  it('a mutation becomes a durable Action with the mapped type, intent, and risk', async () => {
    run.mockClear()
    const port = makePort()
    const extension = makeExtension(port)
    const reply = await extension.execute('reminders_create', { title: 'Send the deck' })
    expect(port.proposed[0]).toMatchObject({
      type: 'reminder',
      intent: 'Create the reminder "Send the deck"',
      args: { title: 'Send the deck' },
      risk: 'mutate'
    })
    expect(reply).toBe('Created the reminder.')
    expect(run).not.toHaveBeenCalled()
    expect(proposeApproval).not.toHaveBeenCalled()
  })

  it('a read runs inline and never touches the engine', async () => {
    run.mockClear()
    const port = makePort()
    const extension = makeExtension(port)
    await extension.execute('reminders_list', {})
    expect(port.proposed).toEqual([])
    expect(run).toHaveBeenCalledWith({ command: 'reminders.list', args: {} })
  })

  it('navigation (open_url) also stays inline', async () => {
    run.mockClear()
    const port = makePort()
    const extension = makeExtension(port)
    await extension.execute('open_url', { url: 'https://x.test' })
    expect(port.proposed).toEqual([])
    expect(run).toHaveBeenCalled()
  })

  it('an action parked at the gate reports pending approval', async () => {
    const port = makePort({
      waitForOutcome: () => new Promise(() => {}),
      whenParked: async () => {}
    })
    const extension = makeExtension(port)
    const reply = await extension.execute('messages_send', { to: 'x@y.z', text: 'hi' })
    expect(reply).toMatch(/pending approval/)
  })

  it('a deduped proposal says it is already queued', async () => {
    const port = makePort({
      propose: async () => ({ accepted: true, id: 'act_1', deduped: true })
    })
    const extension = makeExtension(port)
    const reply = await extension.execute('reminders_create', { title: 'x' })
    expect(reply).toMatch(/already queued/)
  })

  it('a refused proposal surfaces the reason', async () => {
    const port = makePort({
      propose: async () => ({ accepted: false, reason: 'no handler' })
    })
    const extension = makeExtension(port)
    const reply = await extension.execute('reminders_create', { title: 'x' })
    expect(reply).toMatch(/refused: no handler/)
  })

  it('rejected and needs_help outcomes report honestly', async () => {
    const rejected = makeExtension(
      makePort({
        waitForOutcome: async () =>
          ({
            id: 'act_1',
            outcome: 'rejected',
            record: { attemptLog: [] }
          }) as unknown as TickOutcome
      })
    )
    expect(await rejected.execute('mail_send', { to: 'a@b.c' })).toMatch(/declined/)

    const needsHelp = makeExtension(
      makePort({
        waitForOutcome: async () =>
          ({
            id: 'act_1',
            outcome: 'needs_help',
            record: {
              attemptLog: [{ rail: 'semantic', at: 1, outcome: 'timeout', detail: 'no answer' }]
            }
          }) as unknown as TickOutcome
      })
    )
    expect(await needsHelp.execute('mail_send', { to: 'a@b.c' })).toMatch(/no answer/)
  })

  it('edited and poisoned outcomes report honestly too', async () => {
    const edited = makeExtension(
      makePort({
        waitForOutcome: async () =>
          ({ id: 'act_1', outcome: 'edited', record: { attemptLog: [] } }) as unknown as TickOutcome
      })
    )
    expect(await edited.execute('reminders_create', { title: 'x' })).toMatch(/editing/)

    const poisoned = makeExtension(
      makePort({
        waitForOutcome: async () =>
          ({ id: 'act_1', outcome: 'poisoned', error: 'bad body' }) as unknown as TickOutcome
      })
    )
    expect(await poisoned.execute('reminders_create', { title: 'x' })).toMatch(/bad body/)

    const helpNoDetail = makeExtension(
      makePort({
        waitForOutcome: async () =>
          ({
            id: 'act_1',
            outcome: 'needs_help',
            record: { attemptLog: [{ rail: 'semantic', at: 1, outcome: 'error' }] }
          }) as unknown as TickOutcome
      })
    )
    expect(await helpNoDetail.execute('reminders_create', { title: 'x' })).toMatch(
      /needs their attention/
    )
  })

  it('a listening pro approval queue keeps the legacy path untouched', async () => {
    run.mockClear()
    const legacyPropose = vi.fn(() => true)
    const port = makePort({ approvalHookActive: () => true })
    const extension = new NativeActionToolExtension(
      { run, proposeApproval: legacyPropose, isProEntitled: proEntitled, actions: port },
      'darwin'
    )
    const reply = await extension.execute('reminders_create', { title: 'x' })
    expect(port.proposed).toEqual([])
    expect(legacyPropose).toHaveBeenCalled()
    expect(reply).toMatch(/pending approval/)
  })

  it('no actions port at all means the legacy path (existing behaviour)', async () => {
    run.mockClear()
    const legacyPropose = vi.fn(() => undefined)
    const extension = new NativeActionToolExtension(
      { run, proposeApproval: legacyPropose, isProEntitled: proEntitled },
      'darwin'
    )
    await extension.execute('reminders_create', { title: 'x' })
    expect(legacyPropose).toHaveBeenCalled()
    expect(run).toHaveBeenCalled()
  })

  it('web_use becomes a browser-rail Action with the goal as its intent', async () => {
    run.mockClear()
    const port = makePort()
    const extension = makeExtension(port)
    const reply = await extension.execute('web_use', {
      goal: 'check in for my flight',
      url: 'https://air.test'
    })
    expect(port.proposed[0]).toMatchObject({
      type: 'web_use',
      intent: 'check in for my flight',
      args: { goal: 'check in for my flight', url: 'https://air.test' },
      risk: 'mutate'
    })
    expect(run).not.toHaveBeenCalled()
    expect(reply).toMatchObject({
      text: expect.stringContaining('Task reference: act_1.'),
      authoritative: true
    })
  })

  it('links a Web Use action to the chat journey', async () => {
    const port = makePort()
    const extension = makeExtension(port)

    await extension.execute(
      'web_use',
      { goal: 'check in for my flight' },
      { conversationId: 'chat-journey-1', userQuery: 'Check me in' }
    )

    expect(port.proposalMeta).toEqual([{ source: 'chat', sourceRef: 'chat-journey-1' }])
  })

  it('web_use uses the engine EVEN WHEN a pro queue is listening - no connector runs a web task', async () => {
    run.mockClear()
    const legacyPropose = vi.fn(() => true)
    const port = makePort({ approvalHookActive: () => true })
    const extension = new NativeActionToolExtension(
      { run, proposeApproval: legacyPropose, isProEntitled: proEntitled, actions: port },
      'darwin'
    )
    await extension.execute('web_use', { goal: 'order lunch' })
    // The engine path was taken; the legacy queue was NOT offered a web task.
    expect(port.proposed).toHaveLength(1)
    expect(legacyPropose).not.toHaveBeenCalled()
  })

  it('web_use refuses cleanly when no engine is wired, rather than falling to a connector', async () => {
    const legacyPropose = vi.fn(() => true)
    const extension = new NativeActionToolExtension(
      { run, proposeApproval: legacyPropose, isProEntitled: proEntitled },
      'darwin'
    )
    const reply = await extension.execute('web_use', { goal: 'x' })
    expect(reply).toMatchObject({
      text: expect.stringMatching(/on-device action engine/),
      authoritative: true
    })
    expect(legacyPropose).not.toHaveBeenCalled()
  })

  it('computer_task becomes a vision-rail Action with the goal as its intent', async () => {
    run.mockClear()
    const port = makePort()
    const extension = makeExtension(port)
    const reply = await extension.execute('computer_task', { goal: 'share the deck in WhatsApp' })
    expect(port.proposed[0]).toMatchObject({
      type: 'computer_task',
      intent: 'share the deck in WhatsApp',
      args: { goal: 'share the deck in WhatsApp' },
      risk: 'mutate'
    })
    expect(run).not.toHaveBeenCalled()
    expect(reply).toMatchObject({
      text: expect.stringContaining('Task reference: act_1.'),
      authoritative: true
    })
  })

  it('queuing a computer_task announces the grounder nudge - but web_use or a semantic tool does not', async () => {
    const announceComputerTask = vi.fn()
    const port = makePort()
    const extension = new NativeActionToolExtension(
      { run, proposeApproval, isProEntitled: proEntitled, announceComputerTask, actions: port },
      'darwin'
    )
    await extension.execute('computer_task', { goal: 'share the deck' })
    expect(announceComputerTask).toHaveBeenCalledTimes(1)
    // The goal is passed so the boundary can check AX viability for the target app.
    expect(announceComputerTask).toHaveBeenCalledWith('share the deck')

    announceComputerTask.mockClear()
    await extension.execute('web_use', { goal: 'check in' })
    await extension.execute('reminders_create', { title: 'x' })
    expect(announceComputerTask).not.toHaveBeenCalled()
  })

  it('computer_task is engine-only too - never offered to the legacy pro queue', async () => {
    run.mockClear()
    const legacyPropose = vi.fn(() => true)
    const port = makePort({ approvalHookActive: () => true })
    const extension = new NativeActionToolExtension(
      { run, proposeApproval: legacyPropose, isProEntitled: proEntitled, actions: port },
      'darwin'
    )
    await extension.execute('computer_task', { goal: 'x' })
    expect(port.proposed).toHaveLength(1)
    expect(legacyPropose).not.toHaveBeenCalled()
  })
})
