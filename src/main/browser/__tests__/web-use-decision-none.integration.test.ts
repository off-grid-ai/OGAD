/**
 * Decision + Reasoning: the Decision model may reject every proposed action. Run for real
 * (Qwen 3.5 9B, Kev 4B, UI-Mate 9B through the browser extension) that ended the task at once,
 * while the same models finished it on the run before. The policy is faked at its boundary;
 * the step loop is real.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const policy = vi.hoisted(() => ({ replies: [] as Array<'none' | 'done'>, notes: [] as string[] }))

vi.mock('../browser-playwright-policy', async (importOriginal) => {
  const real = await importOriginal<typeof import('../browser-playwright-policy')>()
  const { NoSupportedActionError } = await import('../semantic-candidates')
  return {
    ...real,
    decideBrowserSemanticAction: vi.fn(async (request: { recoveryNote: string }) => {
      policy.notes.push(request.recoveryNote)
      if (policy.replies.shift() === 'none') throw new NoSupportedActionError()
      return {
        action: 'done',
        phase_id: 'phase-1',
        element: null,
        ref: null,
        text: null,
        key: null,
        values: null,
        start_element: null,
        start_ref: null,
        end_element: null,
        end_ref: null,
        url: null,
        evidence_ref: null,
        evidence_text: 'Synthetic Outfitters',
        reason: '',
        summary: 'Read the heading.'
      }
    })
  }
})

import { runBrowserPlaywrightTask } from '../browser-playwright-task'
import type { PlaywrightMcpSession, PlaywrightToolResult } from '../playwright-mcp-session'
import type { BrowserDriver } from '../browser-driver'
import { VisionGuard } from '../../vision/vision-guard'

function run(taskId: string): ReturnType<typeof runBrowserPlaywrightTask> {
  const session = {
    snapshot: async (): Promise<PlaywrightToolResult> => ({
      text: 'heading "Synthetic Outfitters" [level=1] [ref=e1]',
      isError: false
    }),
    call: async (): Promise<PlaywrightToolResult> => ({ text: 'ok', isError: false }),
    recoverPage: async (): Promise<PlaywrightToolResult> => ({ text: 'ok', isError: false })
  } as unknown as PlaywrightMcpSession
  return runBrowserPlaywrightTask({
    goal: 'Report the main heading',
    plan: { version: 1, phases: [{ id: 'phase-1', title: 'Read the heading' }] },
    session,
    guard: new VisionGuard({ taskId, kind: 'web_use' }),
    activeDriver: () => ({}) as unknown as BrowserDriver,
    activeUrl: () => 'http://127.0.0.1:8090/shop.html',
    waitForUser: async () => undefined,
    takeGuidance: () => [],
    onStep: () => undefined,
    onPhase: () => undefined,
    onProgress: () => undefined
  })
}

beforeEach(() => {
  policy.replies.length = 0
  policy.notes.length = 0
})

describe('Web Use when the Decision model rejects every proposal', () => {
  it('asks again from a fresh snapshot instead of ending the task', async () => {
    policy.replies.push('none', 'done')
    const result = await run('web-decision-none-retry')
    expect(result.ok).toBe(true)
    expect(policy.notes[1]).toMatch(/rejected every proposed action/)
  })

  it('still stops when it keeps rejecting on an unchanged page', async () => {
    // Five steps without progress, as browser-use stops at five consecutive failures.
    policy.replies.push(...Array.from({ length: 8 }, () => 'none' as const))
    const result = await run('web-decision-none-stuck')
    expect(result.ok).toBe(false)
    expect(policy.notes.length).toBeLessThanOrEqual(5)
  })
})
