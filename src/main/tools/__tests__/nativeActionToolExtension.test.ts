/**
 * Execute-path tests for the native-action tool extension against a fake boundary
 * (the same injection seam the MCP extension uses). Pins the gate-then-run contract:
 * a Chat mutation requires the durable action engine and never falls back to an approval
 * copy or an inline write. Read tools still run inline.
 */
import { describe, expect, it, beforeEach } from 'vitest'
import {
  NativeActionToolExtension,
  registerNativeActionTools,
  type NativeActionToolBoundary
} from '../nativeActionToolExtension'
import type { ToolExtension } from '../../tools'
import type { ActionApprovalRequest } from '../../actions/approval'
import type { NativeActionCommand, NativeActionResponse } from '../../actions/native-helper-logic'

class FakeBoundary implements NativeActionToolBoundary {
  readonly commands: NativeActionCommand[] = []
  readonly approvals: ActionApprovalRequest[] = []
  queueApprovals = false
  response: NativeActionResponse = { ok: true, result: { id: 'E1' } }
  proEntitled = true

  isProEntitled(): boolean {
    return this.proEntitled
  }

  async run(cmd: NativeActionCommand): Promise<NativeActionResponse> {
    this.commands.push(cmd)
    return this.response
  }

  proposeApproval(request: ActionApprovalRequest): boolean {
    this.approvals.push(request)
    return this.queueApprovals
  }
}

let boundary: FakeBoundary
let ext: NativeActionToolExtension

beforeEach(() => {
  boundary = new FakeBoundary()
  // Pin darwin: these assert the full macOS tool set. Defaulting to
  // process.platform makes specsForPlatform('linux') empty on CI, so every
  // tool reads as unknown and the whole file fails.
  ext = new NativeActionToolExtension(boundary, 'darwin')
})

describe('NativeActionToolExtension', () => {
  it('owns only its known tool names', () => {
    expect(ext.canHandle('calendar_create_event')).toBe(true)
    expect(ext.canHandle('calendar_list_events')).toBe(true)
    expect(ext.canHandle('mcp__1__send')).toBe(false)
  })

  it('hides and refuses Browser Use and Computer Use without Pro', async () => {
    boundary.proEntitled = false

    expect(ext.canHandle('web_use')).toBe(false)
    expect(ext.canHandle('computer_task')).toBe(false)
    expect(ext.schemas()).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ function: expect.objectContaining({ name: 'web_use' }) })
      ])
    )
    expect(ext.systemHint()).not.toContain('web_use')
    // Authoritative, like every other task-action outcome: the refusal is the final word the
    // model reports, not a note it can paraphrase into "I ran it" or talk the user past.
    await expect(ext.execute('web_use', { goal: 'Buy something' })).resolves.toEqual({
      text: 'Error: Browser Use and Computer Use require Off Grid AI Pro.',
      status: 'failed',
      authoritative: true
    })
    expect(boundary.commands).toEqual([])
    expect(boundary.approvals).toEqual([])
  })

  it('does not create an approval copy when the Chat action engine is unavailable', async () => {
    boundary.queueApprovals = true
    const out = await ext.execute('calendar_create_event', {
      title: 'Sync',
      start: '2026-08-13T15:00:00'
    })

    expect(out).toContain('on-device action engine')
    expect(boundary.approvals).toEqual([])
    expect(boundary.commands).toEqual([])
  })

  it('does not bypass the missing durable engine with an inline Chat write', async () => {
    boundary.queueApprovals = false
    const out = await ext.execute('calendar_create_event', {
      title: 'Sync',
      start: '2026-08-13T15:00:00'
    })

    expect(out).toContain('on-device action engine')
    expect(boundary.approvals).toEqual([])
    expect(boundary.commands).toEqual([])
  })

  it('never sends a Chat message through the legacy approval path', async () => {
    boundary.queueApprovals = true
    const out = await ext.execute('messages_send', { to: '+15551234567', text: 'on my way' })

    expect(out).toContain('on-device action engine')
    expect(boundary.approvals).toEqual([])
    expect(boundary.commands).toEqual([])
  })

  it('runs a read tool without ever offering it for approval', async () => {
    boundary.response = { ok: true, result: { events: [] } }
    const out = await ext.execute('calendar_list_events', {
      start: '2026-08-13T00:00:00',
      end: '2026-08-14T00:00:00'
    })

    expect(out).toBe('{"events":[]}')
    expect(boundary.approvals).toEqual([])
    expect(boundary.commands).toEqual([
      {
        command: 'calendar.listEvents',
        args: { start: '2026-08-13T00:00:00', end: '2026-08-14T00:00:00' }
      }
    ])
  })

  it('passes a helper failure back as an error string', async () => {
    boundary.response = { ok: false, error: 'calendar access was not granted' }
    expect(await ext.execute('calendar_list_events', { start: 'a', end: 'b' })).toBe(
      'Error: calendar access was not granted'
    )
  })

  it('rejects an unknown tool name', async () => {
    expect(await ext.execute('calendar_delete_all', {})).toBe(
      'Error: unknown action calendar_delete_all'
    )
  })
})

describe('registerNativeActionTools', () => {
  it('registers the extension on macOS', () => {
    const registered: ToolExtension[] = []
    registerNativeActionTools((e) => registered.push(e), 'darwin')
    expect(registered.map((e) => e.id)).toEqual(['native-actions'])
  })

  it('registers on Windows too (the Outlook subset) and nothing on other platforms', () => {
    // R2-A1: win32 exposes the engine-routed Outlook set; platforms with an
    // empty spec list stay unregistered so the grammar budget is untouched.
    const registered: ToolExtension[] = []
    registerNativeActionTools((e) => registered.push(e), 'win32')
    expect(registered.map((e) => e.id)).toEqual(['native-actions'])
    const elsewhere: ToolExtension[] = []
    registerNativeActionTools((e) => elsewhere.push(e), 'linux')
    expect(elsewhere).toEqual([])
  })
})
