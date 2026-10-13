/**
 * Focused Web Use control journeys. Off Grid policy, lifecycle, and action
 * dispatch are real. Only the remote model, Playwright MCP, and pointer driver
 * boundaries are faked.
 */
import type { BrowserLink } from '../../extension-bridge/bridge-socket'
import type { SocketEvent } from '../../extension-bridge/bridge-socket-protocol'
import type { TaskRunUpdate } from '../../tasks/task-history-store'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const history = vi.hoisted(() => ({ updates: [] as TaskRunUpdate[] }))

vi.mock('../../tasks/task-history', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../tasks/task-history')>()),
  getTaskExecutionDevice: () => ({ id: 'test-device', name: 'Test device' }),
  recordTaskRun: (update: TaskRunUpdate) => history.updates.push(update),
  reportTaskProgress: () => undefined
}))

const model = vi.hoisted(() => ({
  replies: [] as Array<string | ((signal?: AbortSignal) => Promise<string>)>
}))

vi.mock('../../llm', () => ({
  llm: {
    chat: vi.fn(
      async (
        _prompt: string,
        _images: unknown[],
        _timeout: number,
        _maxTokens: number,
        options?: { signal?: AbortSignal }
      ) => {
        const reply = model.replies.shift()
        if (typeof reply === 'function') return reply(options?.signal)
        if (typeof reply === 'string') return reply
        throw new Error('The model boundary has no queued reply.')
      }
    )
  }
}))

import { createExtensionBrowserHost } from '../extension-browser-host'
import {
  completionSummary,
  readableEvidence,
  runBrowserPlaywrightTask
} from '../browser-playwright-task'
import {
  boundedSnapshot,
  completionEvidenceMatches,
  repairDecision,
  type SemanticDecision
} from '../browser-playwright-policy'
import { llm } from '../../llm'
import type { PlaywrightMcpSession, PlaywrightToolResult } from '../playwright-mcp-session'
import type { BrowserDriver } from '../browser-driver'
import { VisionGuard } from '../../vision/vision-guard'

const plan = {
  version: 1 as const,
  phases: [{ id: 'phase-1', title: 'Submit the form' }]
}

function decision(value: {
  action: 'click' | 'done' | 'human_required'
  ref?: string
  element?: string
  evidenceText?: string
  reason?: string
  summary?: string
}): string {
  return JSON.stringify({
    action: value.action,
    phase_id: 'phase-1',
    element: value.element ?? null,
    ref: value.ref ?? null,
    text: null,
    key: null,
    values: null,
    start_element: null,
    start_ref: null,
    end_element: null,
    end_ref: null,
    url: null,
    evidence_ref: null,
    evidence_text: value.evidenceText ?? null,
    reason: value.reason ?? '',
    summary: value.summary ?? ''
  })
}

function abortableReply(
  value: string,
  started: () => void
): (signal?: AbortSignal) => Promise<string> {
  return (signal) =>
    new Promise((resolve, reject) => {
      started()
      const timer = setTimeout(() => {
        signal?.removeEventListener('abort', abort)
        resolve(value)
      }, 30)
      const abort = (): void => {
        clearTimeout(timer)
        reject(signal?.reason ?? new DOMException('Aborted', 'AbortError'))
      }
      signal?.addEventListener('abort', abort, { once: true })
    })
}

function boundarySession(snapshots: string[], calls: string[]): PlaywrightMcpSession {
  return {
    snapshot: async (): Promise<PlaywrightToolResult> => ({
      text: snapshots.shift() ?? snapshots.at(-1) ?? 'button "Submit" [ref=s1]',
      isError: false
    }),
    call: async (name: string): Promise<PlaywrightToolResult> => {
      calls.push(name)
      return { text: 'completed', isError: false }
    },
    recoverPage: async (): Promise<PlaywrightToolResult> => ({ text: 'recovered', isError: false })
  } as unknown as PlaywrightMcpSession
}

function pointerDriver(projected: string[]): BrowserDriver {
  return {
    projectSemanticTarget: async (ref: string) => void projected.push(ref)
  } as unknown as BrowserDriver
}

beforeEach(() => {
  model.replies.length = 0
  history.updates.length = 0
})

describe('Web Use shared lifecycle', () => {
  it('follows an Apply Now child tab in the host and records the task step', async () => {
    model.replies.push(
      decision({ action: 'click', ref: 's1', element: 'Apply Now' }),
      decision({
        action: 'done',
        evidenceText: 'Application form',
        summary: 'The application form is open.'
      })
    )
    const events = new Set<(event: SocketEvent) => void>()
    const calls: Array<{ tabId: unknown; tool: unknown }> = []
    const link: BrowserLink = {
      browser: { id: 'device000001', name: 'Firefox extension', publicKey: 'k', pairedAt: 1 },
      async request(op, args = {}) {
        if (op === 'tab.adopt') return { tabId: 7, url: 'https://jobs.test/', title: 'Jobs' }
        if (op === 'browser.caps') return { cdp: false }
        if (op !== 'page.call') return {}
        calls.push({ tabId: args.tabId, tool: args.tool })
        if (args.tool === 'browser_click') {
          for (const listener of [...events])
            listener({
              event: 'tab.opened',
              tabId: 8,
              data: { tabId: 8, openerTabId: 7, url: 'https://jobs.test/apply', title: 'Apply' }
            })
          return { text: 'Clicked Apply Now.', isError: false }
        }
        return {
          text:
            args.tabId === 7
              ? 'button "Apply Now" [ref=s1]'
              : 'heading "Application form" [ref=s2]',
          isError: false
        }
      },
      onEvent(listener) {
        events.add(listener)
        return () => events.delete(listener)
      },
      onClose: () => () => undefined,
      close: () => undefined
    }
    const result = await createExtensionBrowserHost(() => link, 7).runTask({
      goal: 'Open the application form',
      taskId: 'web-child-tab',
      journeyId: 'child-tab-journey',
      checkpoint: { taskId: 'web-child-tab', steps: [], plan }
    })
    expect(result).toMatchObject({ ok: true, finalUrl: 'https://jobs.test/apply' })
    expect(calls).toEqual([
      { tabId: 7, tool: 'browser_snapshot' },
      { tabId: 7, tool: 'browser_click' },
      { tabId: 8, tool: 'browser_snapshot' },
      { tabId: 8, tool: 'browser_snapshot' }
    ])
    const note = 'The page opened a new tab. Continuing there.'
    expect(result.steps.filter((step) => step === note)).toHaveLength(1)
    expect(history.updates.some((update) => update.steps?.includes(note))).toBe(true)
    expect(events.size).toBe(0)
  })

  it('publishes bounded replay observations for a semantic-only task', async () => {
    model.replies.push(
      decision({ action: 'click', ref: 's1', element: 'Submit' }),
      decision({ action: 'done', evidenceText: 'Saved', summary: 'The form was saved.' })
    )
    const observations: Array<{ step: number; phase: string; summary: string }> = []
    const result = await runBrowserPlaywrightTask({
      goal: 'Submit the form',
      plan,
      session: boundarySession(
        ['button "Submit" [ref=s1]', 'status "Saved" [ref=s2]', 'status "Saved" [ref=s2]'],
        []
      ),
      guard: new VisionGuard({ taskId: 'web-semantic-replay', kind: 'web_use' }),
      activeDriver: () => pointerDriver([]),
      activeUrl: () => 'https://example.test/form',
      waitForUser: async () => undefined,
      takeGuidance: () => [],
      onStep: () => undefined,
      onPhase: () => undefined,
      onProgress: () => undefined,
      onObservation: async (observation) => void observations.push(observation)
    })

    expect(result.ok).toBe(true)
    expect(observations).toEqual([
      { step: 0, phase: 'observing', summary: 'Initial page' },
      { step: 1, phase: 'checking', summary: 'click' },
      { step: 2, phase: 'complete', summary: 'The form was saved.' }
    ])
  })

  it('discards a late Playwright snapshot after Pause and requires a fresh snapshot after Resume', async () => {
    let markSnapshotStarted: (() => void) | undefined
    const snapshotStarted = new Promise<void>((resolve) => {
      markSnapshotStarted = resolve
    })
    let snapshotCalls = 0
    const session = {
      snapshot: async (signal?: AbortSignal): Promise<PlaywrightToolResult> => {
        snapshotCalls += 1
        if (snapshotCalls > 1) {
          return { text: 'status "Saved" [ref=s2]', isError: false }
        }
        markSnapshotStarted?.()
        return new Promise((resolve, reject) => {
          const timer = setTimeout(
            () => resolve({ text: 'button "Old submit" [ref=old1]', isError: false }),
            30
          )
          const abort = (): void => {
            clearTimeout(timer)
            reject(signal?.reason ?? new DOMException('Aborted', 'AbortError'))
          }
          signal?.addEventListener('abort', abort, { once: true })
        })
      },
      recoverPage: async (): Promise<PlaywrightToolResult> => ({
        text: 'recovered',
        isError: false
      })
    } as unknown as PlaywrightMcpSession
    model.replies.push(
      decision({ action: 'done', evidenceText: 'Saved', summary: 'The form was saved.' })
    )
    const guard = new VisionGuard({ taskId: 'web-snapshot-lease', kind: 'web_use' })

    const run = runBrowserPlaywrightTask({
      goal: 'Submit the form',
      plan,
      session,
      guard,
      activeDriver: () => pointerDriver([]),
      activeUrl: () => 'https://example.test/form',
      waitForUser: async () => undefined,
      takeGuidance: () => [],
      onStep: () => undefined,
      onPhase: () => undefined,
      onProgress: () => undefined
    })

    await snapshotStarted
    expect(guard.pause()).toBe(true)
    expect(guard.resume()).toBe(true)

    await expect(run).resolves.toMatchObject({ ok: true, summary: 'The form was saved.' })
    expect(snapshotCalls).toBe(3)
    expect(guard.snapshot().status).toBe('completed')
  })

  it('discards a late model reply, re-observes after Resume, and completes only after verification', async () => {
    let markModelStarted: (() => void) | undefined
    const modelStarted = new Promise<void>((resolve) => {
      markModelStarted = resolve
    })
    model.replies.push(
      abortableReply(decision({ action: 'click', ref: 's1', element: 'Submit' }), () =>
        markModelStarted?.()
      ),
      decision({ action: 'click', ref: 's1', element: 'Submit' }),
      decision({ action: 'done', evidenceText: 'Saved', summary: 'The form was saved.' })
    )
    const calls: string[] = []
    const projected: string[] = []
    const guard = new VisionGuard({ taskId: 'web-pause-resume', kind: 'web_use' })
    const session = boundarySession(
      [
        'button "Submit" [ref=s1]',
        'button "Submit" [ref=s1]',
        'status "Saved" [ref=s2]',
        'status "Saved" [ref=s2]'
      ],
      calls
    )

    const run = runBrowserPlaywrightTask({
      goal: 'Submit the form',
      plan,
      session,
      guard,
      activeDriver: () => pointerDriver(projected),
      activeUrl: () => 'https://example.test/form',
      waitForUser: async () => undefined,
      takeGuidance: () => [],
      onStep: () => undefined,
      onPhase: () => undefined,
      onProgress: () => undefined
    })

    await modelStarted
    expect(guard.pause('Paused by the user')).toBe(true)
    expect(calls).toEqual([])
    expect(guard.resume()).toBe(true)

    await expect(run).resolves.toMatchObject({
      ok: true,
      fallback: false,
      summary: 'The form was saved.'
    })
    expect(calls).toEqual(['browser_click'])
    expect(projected).toEqual(['s1'])
    expect(guard.snapshot()).toMatchObject({ status: 'completed', kind: 'web_use' })
  })

  it('cancels an in-flight Playwright action on Pause and does not interpret its late result', async () => {
    let markActionStarted: (() => void) | undefined
    const actionStarted = new Promise<void>((resolve) => {
      markActionStarted = resolve
    })
    let actionCalls = 0
    const session = {
      snapshot: vi
        .fn()
        .mockResolvedValueOnce({ text: 'button "Submit" [ref=s1]', isError: false })
        .mockResolvedValue({ text: 'status "Saved" [ref=s2]', isError: false }),
      call: async (_name: string, _args: unknown, signal?: AbortSignal) => {
        actionCalls += 1
        markActionStarted?.()
        return new Promise<PlaywrightToolResult>((resolve, reject) => {
          const timer = setTimeout(() => resolve({ text: 'late completion', isError: false }), 30)
          const abort = (): void => {
            clearTimeout(timer)
            reject(signal?.reason ?? new DOMException('Aborted', 'AbortError'))
          }
          signal?.addEventListener('abort', abort, { once: true })
        })
      },
      recoverPage: async (): Promise<PlaywrightToolResult> => ({
        text: 'recovered',
        isError: false
      })
    } as unknown as PlaywrightMcpSession
    model.replies.push(
      decision({ action: 'click', ref: 's1', element: 'Submit' }),
      decision({ action: 'done', evidenceText: 'Saved', summary: 'The form was saved.' })
    )
    const guard = new VisionGuard({ taskId: 'web-action-lease', kind: 'web_use' })

    const run = runBrowserPlaywrightTask({
      goal: 'Submit the form',
      plan,
      session,
      guard,
      activeDriver: () => pointerDriver([]),
      activeUrl: () => 'https://example.test/form',
      waitForUser: async () => undefined,
      takeGuidance: () => [],
      onStep: () => undefined,
      onPhase: () => undefined,
      onProgress: () => undefined
    })

    await actionStarted
    expect(guard.pause()).toBe(true)
    expect(guard.resume()).toBe(true)

    await expect(run).resolves.toMatchObject({ ok: true, summary: 'The form was saved.' })
    expect(actionCalls).toBe(1)
    expect(guard.snapshot().status).toBe('completed')
  })

  it('parks for a human-only step and continues the same task from a fresh page snapshot', async () => {
    model.replies.push(
      decision({ action: 'human_required', reason: 'Enter the one-time code.' }),
      decision({ action: 'done', evidenceText: 'Signed in', summary: 'You are signed in.' })
    )
    const guard = new VisionGuard({ taskId: 'web-human-step', kind: 'web_use' })
    const session = boundarySession(
      [
        'textbox "One-time code" [ref=otp1]',
        'status "Signed in" [ref=done1]',
        'status "Signed in" [ref=done1]'
      ],
      []
    )
    let waiting = false

    const run = runBrowserPlaywrightTask({
      goal: 'Sign in',
      plan,
      session,
      guard,
      activeDriver: () => pointerDriver([]),
      activeUrl: () => 'https://example.test/sign-in',
      waitForUser: async (reason) => {
        waiting = true
        expect(reason).toBe('Enter the one-time code.')
        expect(guard.requestUser(reason)).toBe(true)
        expect(guard.snapshot().status).toBe('waiting_for_user')
        expect(guard.resume()).toBe(true)
      },
      takeGuidance: () => [],
      onStep: () => undefined,
      onPhase: () => undefined,
      onProgress: () => undefined
    })

    await expect(run).resolves.toMatchObject({ ok: true, summary: 'You are signed in.' })
    expect(waiting).toBe(true)
    expect(guard.snapshot().status).toBe('completed')
  })

  it('fails completion when the current page no longer contains the model evidence', async () => {
    model.replies.push(
      decision({
        action: 'done',
        evidenceText: 'Order complete',
        summary: 'The order is complete.'
      })
    )
    const guard = new VisionGuard({ taskId: 'web-current-evidence', kind: 'web_use' })
    const notes: string[] = []
    const session = boundarySession(
      ['heading "Order complete" [ref=done1]', 'heading "Your cart" [ref=cart1]'],
      []
    )

    const result = await runBrowserPlaywrightTask({
      goal: 'Complete the order',
      plan,
      session,
      guard,
      activeDriver: () => pointerDriver([]),
      activeUrl: () => 'https://example.test/cart',
      waitForUser: async () => undefined,
      takeGuidance: () => [],
      onStep: (note) => void notes.push(note),
      onPhase: () => undefined,
      onProgress: () => undefined
    })

    expect(result).toEqual({
      ok: false,
      fallback: false,
      summary: 'The final page no longer contained the evidence required for completion.',
      handoffs: 0
    })
    expect(notes).toContain(
      'verification failed: The final page no longer contained the evidence required for completion.'
    )
    expect(guard.snapshot()).toMatchObject({ status: 'failed', kind: 'web_use' })
  })

  it('stops after a few stale references on an unchanged page instead of using every step', async () => {
    // Found against a real browser extension: a small model kept acting on a ref the page did
    // not have, re-observed after each stale-reference error, and used all 24 steps.
    for (let i = 0; i < 24; i += 1) {
      model.replies.push(decision({ action: 'click', ref: 'e9', element: 'Heading' }))
    }
    const calls: string[] = []
    const session = {
      snapshot: async (): Promise<PlaywrightToolResult> => ({
        text: 'button "Submit" [ref=s1]',
        isError: false
      }),
      call: async (name: string): Promise<PlaywrightToolResult> => {
        calls.push(name)
        return {
          text: 'Element 9 not found, the id is stale. Take a fresh snapshot.',
          isError: true
        }
      },
      recoverPage: async (): Promise<PlaywrightToolResult> => ({ text: 'ok', isError: false })
    } as unknown as PlaywrightMcpSession
    const result = await runBrowserPlaywrightTask({
      goal: 'Read the heading',
      plan,
      session,
      guard: new VisionGuard({ taskId: 'web-stale-loop', kind: 'web_use' }),
      activeDriver: () => pointerDriver([]),
      activeUrl: () => 'https://example.test/form',
      waitForUser: async () => undefined,
      takeGuidance: () => [],
      onStep: () => undefined,
      onPhase: () => undefined,
      onProgress: () => undefined
    })
    expect(result.ok).toBe(false)
    expect(calls.length).toBeLessThanOrEqual(5)
  })
  describe('a failed or unchanged action', () => {
    const FORM =
      'textbox "Password" [required] [ref=e1]\nbutton "Create Account" [disabled] [ref=e2]\nbutton "Next" [ref=e3]'
    const DISABLED =
      '"Create Account" is disabled, so clicking it does nothing. Fill the fields marked required or invalid first.'

    function run(
      session: PlaywrightMcpSession,
      notes: string[]
    ): ReturnType<typeof runBrowserPlaywrightTask> {
      return runBrowserPlaywrightTask({
        goal: 'Create the account',
        plan,
        session,
        guard: new VisionGuard({ taskId: 'web-failed-action', kind: 'web_use' }),
        activeDriver: () => pointerDriver([]),
        activeUrl: () => 'https://example.test/signup',
        waitForUser: async () => undefined,
        takeGuidance: () => [],
        onStep: (note) => void notes.push(note),
        onPhase: () => undefined,
        onProgress: () => undefined
      })
    }

    /** A page no action changes. */
    function unchangedPage(): PlaywrightMcpSession {
      return {
        snapshot: async (): Promise<PlaywrightToolResult> => ({ text: FORM, isError: false }),
        call: async (): Promise<PlaywrightToolResult> => ({ text: 'completed', isError: false }),
        recoverPage: async (): Promise<PlaywrightToolResult> => ({ text: 'ok', isError: false })
      } as unknown as PlaywrightMcpSession
    }

    function failingFirst(snapshots: string[], calls: string[]): PlaywrightMcpSession {
      return {
        snapshot: async (): Promise<PlaywrightToolResult> => ({
          text: snapshots.length > 1 ? (snapshots.shift() as string) : (snapshots[0] ?? FORM),
          isError: false
        }),
        call: async (name: string): Promise<PlaywrightToolResult> => {
          calls.push(name)
          return calls.length === 1
            ? { text: DISABLED, isError: true }
            : { text: 'completed', isError: false }
        },
        recoverPage: async (): Promise<PlaywrightToolResult> => ({ text: 'ok', isError: false })
      } as unknown as PlaywrightMcpSession
    }

    it('re-observes after a refused click and lets the model choose again', async () => {
      // Found against a real signup page: a click on a disabled Create Account button used to
      // end the task on the spot ("Semantic action failed"), or, in the browser, report a
      // click that did nothing.
      model.replies.push(
        decision({ action: 'click', ref: 'e2', element: 'Create Account', summary: 'Create' }),
        decision({ action: 'click', ref: 'e3', element: 'Next', summary: 'Next' }),
        decision({ action: 'done', evidenceText: 'Account created', summary: 'Account created.' })
      )
      const calls: string[] = []
      const notes: string[] = []
      const done = 'heading "Account created" [ref=d1]'
      const result = await run(failingFirst([FORM, FORM, done, done], calls), notes)
      expect(result).toMatchObject({ ok: true, summary: 'Account created.' })
      expect(calls).toEqual(['browser_click', 'browser_click'])
      expect(notes).toContain(`re-observed the page after the action failed: ${DISABLED}`)
    })

    it('shows the model what its last steps did, and keeps the user guidance on every step', async () => {
      // From browser-use and Nanobrowser: each step sees its own recent actions and results.
      // Found live: with no history, a small model repeated steps and lost track.
      vi.mocked(llm.chat).mockClear()
      model.replies.push(
        decision({ action: 'click', ref: 'e3', element: 'Next', summary: 'Click Next.' }),
        decision({ action: 'click', ref: 'e1', element: 'Password', summary: 'Focus Password.' }),
        decision({ action: 'done', evidenceText: 'Account created', summary: 'Account created.' })
      )
      // First page, unchanged after Next, then changed after Password (and checked when done).
      const pages = [FORM, FORM, 'heading "Account created" [ref=d1]']
      const session = {
        snapshot: async (): Promise<PlaywrightToolResult> => ({
          text: pages.length > 1 ? (pages.shift() as string) : pages[0]!,
          isError: false
        }),
        call: async (): Promise<PlaywrightToolResult> => ({ text: 'completed', isError: false }),
        recoverPage: async (): Promise<PlaywrightToolResult> => ({ text: 'ok', isError: false })
      } as unknown as PlaywrightMcpSession
      const guidance = [['I finished the CAPTCHA.']]
      const result = await runBrowserPlaywrightTask({
        goal: 'Create the account',
        plan,
        session,
        guard: new VisionGuard({ taskId: 'web-history', kind: 'web_use' }),
        activeDriver: () => pointerDriver([]),
        activeUrl: () => 'https://example.test/signup',
        waitForUser: async () => undefined,
        takeGuidance: () => guidance.shift() ?? [],
        onStep: () => undefined,
        onPhase: () => undefined,
        onProgress: () => undefined
      })
      expect(result.ok).toBe(true)
      const prompts = vi.mocked(llm.chat).mock.calls.map((call) => String(call[0]))
      expect(prompts[0]).toContain('This is your first step on this page.')
      expect(prompts[1]).toContain('1. Click Next -> no visible change')
      expect(prompts[2]).toContain('2. Focus Password -> the page changed')
      for (const prompt of prompts) expect(prompt).toContain('I finished the CAPTCHA.')
    })

    it('asks again after a reply that is not an action that can run, instead of ending', async () => {
      // Found against a real signup page: a small model proposed navigate with no usable URL
      // and the whole task ended ("navigate requires an HTTP or HTTPS URL").
      const navigate = JSON.parse(decision({ action: 'click', summary: 'Go' })) as Record<
        string,
        unknown
      >
      model.replies.push(
        JSON.stringify({ ...navigate, action: 'navigate', url: 'Continue' }),
        decision({ action: 'click', ref: 'e3', element: 'Next', summary: 'Next' }),
        decision({ action: 'done', evidenceText: 'Account created', summary: 'Account created.' })
      )
      const calls: string[] = []
      const notes: string[] = []
      const done = 'heading "Account created" [ref=d1]'
      const session = {
        snapshot: async (): Promise<PlaywrightToolResult> => ({
          text: calls.length ? done : FORM,
          isError: false
        }),
        call: async (name: string): Promise<PlaywrightToolResult> => {
          calls.push(name)
          return { text: 'completed', isError: false }
        },
        recoverPage: async (): Promise<PlaywrightToolResult> => ({ text: 'ok', isError: false })
      } as unknown as PlaywrightMcpSession
      const result = await run(session, notes)
      expect(result).toMatchObject({ ok: true, summary: 'Account created.' })
      expect(calls).toEqual(['browser_click'])
      expect(notes).toContain(
        're-observed the page after an action that could not run: navigate requires an HTTP or HTTPS URL'
      )
    })

    it('does not reload the page the task is already on', async () => {
      // Found live: the plan began "Navigate to the sign-up page" while the user was on it, and
      // the reload cleared the password the vault had filled.
      const base = JSON.parse(decision({ action: 'click', summary: 'Go' })) as Record<
        string,
        unknown
      >
      model.replies.push(
        JSON.stringify({
          ...base,
          action: 'navigate',
          url: 'https://example.test/signup/',
          summary: 'Open the sign-up page'
        }),
        decision({ action: 'click', ref: 'e3', element: 'Next', summary: 'Next' }),
        decision({ action: 'done', evidenceText: 'Account created', summary: 'Account created.' })
      )
      const calls: string[] = []
      const notes: string[] = []
      const done = 'heading "Account created" [ref=d1]'
      const session = {
        snapshot: async (): Promise<PlaywrightToolResult> => ({
          text: calls.length ? done : FORM,
          isError: false
        }),
        call: async (name: string): Promise<PlaywrightToolResult> => {
          calls.push(name)
          return { text: 'completed', isError: false }
        },
        recoverPage: async (): Promise<PlaywrightToolResult> => ({ text: 'ok', isError: false })
      } as unknown as PlaywrightMcpSession
      const result = await run(session, notes)
      expect(result).toMatchObject({ ok: true })
      expect(calls).toEqual(['browser_click'])
      expect(notes).toContain('stayed on the page instead of reloading it (Open the sign-up page)')
    })

    it('refuses a ref the page never printed, and asks again', async () => {
      // Found live: a small model put a link's text where the ref goes; the click failed.
      model.replies.push(
        decision({
          action: 'click',
          ref: 'Sudden drop in traffic',
          element: 'Story',
          summary: 'Open'
        }),
        decision({ action: 'click', ref: 'e3', element: 'Next', summary: 'Next' }),
        decision({ action: 'done', evidenceText: 'Account created', summary: 'Account created.' })
      )
      const calls: string[] = []
      const notes: string[] = []
      const done = 'heading "Account created" [ref=d1]'
      const session = {
        snapshot: async (): Promise<PlaywrightToolResult> => ({
          text: calls.length ? done : FORM,
          isError: false
        }),
        call: async (name: string): Promise<PlaywrightToolResult> => {
          calls.push(name)
          return { text: 'completed', isError: false }
        },
        recoverPage: async (): Promise<PlaywrightToolResult> => ({ text: 'ok', isError: false })
      } as unknown as PlaywrightMcpSession
      const result = await run(session, notes)
      expect(result).toMatchObject({ ok: true })
      expect(calls).toEqual(['browser_click'])
      expect(notes.some((n) => n.includes('is not on this page'))).toBe(true)
    })

    it('stops when the model keeps proposing actions that cannot run', async () => {
      const navigate = JSON.parse(decision({ action: 'click', summary: 'Go' })) as Record<
        string,
        unknown
      >
      for (let i = 0; i < 6; i += 1) {
        model.replies.push(JSON.stringify({ ...navigate, action: 'navigate', url: 'Continue' }))
      }
      const result = await run(unchangedPage(), [])
      expect(result.summary).toBe(
        'Stopped: the model kept proposing actions that cannot run (navigate requires an HTTP or HTTPS URL).'
      )
    })

    it('stops with the reason the action kept failing, in words the user can act on', async () => {
      for (let i = 0; i < 6; i += 1) {
        model.replies.push(
          decision({ action: 'click', ref: 'e2', element: 'Create Account', summary: 'Create' })
        )
      }
      const calls: string[] = []
      const session = {
        snapshot: async (): Promise<PlaywrightToolResult> => ({ text: FORM, isError: false }),
        call: async (name: string): Promise<PlaywrightToolResult> => {
          calls.push(name)
          return { text: DISABLED, isError: true }
        },
        recoverPage: async (): Promise<PlaywrightToolResult> => ({ text: 'ok', isError: false })
      } as unknown as PlaywrightMcpSession
      const result = await run(session, [])
      expect(result).toEqual({
        ok: false,
        fallback: true,
        summary: `Stopped: ${DISABLED}`,
        handoffs: 0
      })
      expect(calls).toHaveLength(5)
    })

    it('names the last action once five steps in a row leave the page unchanged', async () => {
      for (let i = 0; i < 5; i += 1) {
        model.replies.push(
          i % 2
            ? decision({
                action: 'click',
                ref: 'e1',
                element: 'Password',
                summary: 'Focus Password.'
              })
            : decision({ action: 'click', ref: 'e3', element: 'Next', summary: 'Click Next.' })
        )
      }
      const result = await run(unchangedPage(), [])
      expect(result.summary).toBe(
        'Stopped: the page did not change for 5 steps in a row. Last: "Click Next".'
      )
    })

    it('names the action the model kept repeating on an unchanged page', async () => {
      for (let i = 0; i < 6; i += 1) {
        model.replies.push(
          decision({ action: 'click', ref: 'e3', element: 'Next', summary: 'Click Next.' })
        )
      }
      const result = await run(unchangedPage(), [])
      expect(result.summary).toBe(
        'Stopped: the model kept repeating "Click Next" on a page that did not change.'
      )
    })
  })
})

describe('completionSummary', () => {
  it('gives the user the answer, not only that it was found', () => {
    // Found live: "Found the title of the top story on Hacker News." with no title.
    expect(
      completionSummary({
        summary: 'Found the title of the top story on Hacker News.',
        evidence_text: 'Sudden drop in Cloudflare bot traffic'
      })
    ).toBe(
      'Found the title of the top story on Hacker News.\n"Sudden drop in Cloudflare bot traffic"'
    )
    expect(
      completionSummary({ summary: 'The top story is "Rust 2.0".', evidence_text: 'Rust 2.0' })
    ).toBe('The top story is "Rust 2.0".')
    expect(completionSummary({ summary: ' ', evidence_text: null })).toBe(
      'The web task is complete.'
    )
  })
})

describe('repairDecision', () => {
  const SNAP = '- radio "Medium" [ref=e7]\n- checkbox "Bacon" [ref=e8]\n- combobox "Size" [ref=e9]'
  const select = (ref: string, values: string[] | null): SemanticDecision =>
    ({ action: 'select_option', ref, element: 'x', values }) as SemanticDecision

  it('clicks a radio button or checkbox the model tried to select', () => {
    // Found live: select_option with no values on a radio, five times, and the task stopped.
    expect(repairDecision(select('e7', null), SNAP)).toMatchObject({
      action: 'click',
      values: null
    })
    expect(repairDecision(select('e8', ['on']), SNAP).action).toBe('click')
  })

  it('leaves a real dropdown choice alone, and clicks a select with nothing to choose', () => {
    expect(repairDecision(select('e9', ['Large']), SNAP)).toMatchObject({
      action: 'select_option',
      values: ['Large']
    })
    expect(repairDecision(select('e9', []), SNAP).action).toBe('click')
  })
})

describe('readableEvidence', () => {
  it('shows the value, not the snapshot syntax', () => {
    // Found live: the answer read `strong[ref=e2079]: 117.6k`.
    expect(readableEvidence('strong[ref=e2079]: 117.6k')).toBe('117.6k')
    expect(readableEvidence('- link "Ada Lovelace" [ref=e12]')).toBe('- link "Ada Lovelace"')
    expect(readableEvidence('"10 December 1815"')).toBe('10 December 1815')
    expect(readableEvidence(null)).toBe('')
  })
})

describe('a click on page layout', () => {
  it('is refused and asked again, as a form is not a control', async () => {
    // Found live: the model clicked a search <form> until the task stopped.
    const page =
      '- form "Search" [ref=e30]\n- textbox "Search" [ref=e31]\n- button "Search" [ref=e32]'
    model.replies.push(
      decision({ action: 'click', ref: 'e30', element: 'Search form', summary: 'Submit' }),
      decision({ action: 'click', ref: 'e32', element: 'Search', summary: 'Search' }),
      decision({ action: 'done', evidenceText: 'Results', summary: 'Searched.' })
    )
    const calls: string[] = []
    const notes: string[] = []
    const session = {
      snapshot: async (): Promise<PlaywrightToolResult> => ({
        text: calls.length ? 'heading "Results" [ref=r1]' : page,
        isError: false
      }),
      call: async (name: string): Promise<PlaywrightToolResult> => {
        calls.push(name)
        return { text: 'completed', isError: false }
      },
      recoverPage: async (): Promise<PlaywrightToolResult> => ({ text: 'ok', isError: false })
    } as unknown as PlaywrightMcpSession
    const result = await runBrowserPlaywrightTask({
      goal: 'Search',
      plan,
      session,
      guard: new VisionGuard({ taskId: 'web-form-click', kind: 'web_use' }),
      activeDriver: () => pointerDriver([]),
      activeUrl: () => 'https://search.test/',
      waitForUser: async () => undefined,
      takeGuidance: () => [],
      onStep: (note) => void notes.push(note),
      onPhase: () => undefined,
      onProgress: () => undefined
    })
    expect(result.ok).toBe(true)
    expect(calls).toEqual(['browser_click'])
    expect(notes.some((n) => n.includes('part of the page layout'))).toBe(true)
  })
})

describe('completionEvidenceMatches', () => {
  const SNAP =
    '- checkbox "checkbox 1" [checked] [ref=e5]\n- checkbox "checkbox 2" [checked] [ref=e6]\n- text: Option 2 is selected'
  it("accepts a state's element ref however the model wrote it", () => {
    // Found live: "both checkboxes are checked" is not on the page; their refs prove it.
    for (const evidence_ref of ['e5', '[ref=e6]', 'ref=e5']) {
      expect(completionEvidenceMatches({ evidence_ref, evidence_text: null }, SNAP)).toBe(true)
    }
    expect(
      completionEvidenceMatches({ evidence_ref: null, evidence_text: 'checkbox 1 [ref=e5]' }, SNAP)
    ).toBe(true)
  })

  it('matches copied words regardless of case, spacing and quotes, and nothing else', () => {
    expect(
      completionEvidenceMatches(
        { evidence_ref: null, evidence_text: '"option 2  IS selected"' },
        SNAP
      )
    ).toBe(true)
    expect(
      completionEvidenceMatches({ evidence_ref: null, evidence_text: 'both are checked' }, SNAP)
    ).toBe(false)
    expect(completionEvidenceMatches({ evidence_ref: 'e99', evidence_text: null }, SNAP)).toBe(
      false
    )
  })
})

describe('repairing a ref and a list of evidence', () => {
  const SNAP =
    '- link "Demographics" [ref=e40]\n- link "History" [ref=e41]\n- link "History" [ref=e42]\n- text: alpha/one beta/two gamma/three'
  const click = (ref: string, element: string): SemanticDecision =>
    ({ action: 'click', ref, element, values: null }) as SemanticDecision

  it("uses the named element's ref when the model wrote something else in the ref field", () => {
    // Found live: ref "Clicking the Demographics link again to ..." on a page with that link.
    expect(
      repairDecision(click('Clicking the Demographics link again', 'Demographics'), SNAP).ref
    ).toBe('e40')
    // Two links named History: not guessed.
    expect(repairDecision(click('the history one', 'History'), SNAP).ref).toBe('the history one')
  })

  it('accepts several values when each one is on the page', () => {
    // Found live: three repository names refused as one string.
    expect(
      completionEvidenceMatches(
        { evidence_ref: null, evidence_text: 'alpha/one, beta/two and gamma/three' },
        SNAP
      )
    ).toBe(true)
    expect(
      completionEvidenceMatches(
        { evidence_ref: null, evidence_text: 'alpha/one, delta/four' },
        SNAP
      )
    ).toBe(false)
  })
})

describe('boundedSnapshot', () => {
  it('keeps the lines the goal asks about on a page too long to send whole', () => {
    // Found live: a Wikipedia article cut to its controls lost the infobox population line.
    const nav = Array.from({ length: 900 }, (_, i) => `- link "Menu item ${i}" [ref=e${i}]`)
    const body = Array.from(
      { length: 900 },
      (_, i) => `- text: Filler paragraph number ${i} about the city`
    )
    const page = [...nav, '- rowheader "Population"', '- cell "14,094,034"', ...body].join('\n')
    const cut = boundedSnapshot(page, 'tell me the population figure shown in its infobox')
    expect(cut.length).toBeLessThan(18_100)
    expect(cut).toContain('- rowheader "Population"')
    expect(cut).toContain('- cell "14,094,034"')
    expect(cut.startsWith('[Snapshot shortened.')).toBe(true)
  })

  it('sends a short page whole', () => {
    expect(boundedSnapshot('- button "Go" [ref=e1]', 'go')).toBe('- button "Go" [ref=e1]')
  })
})

describe('a page still loading', () => {
  it('reads it again until it shows controls, instead of giving up at once', async () => {
    // Found live: "The page did not expose usable semantic controls" on a page that loaded later.
    model.replies.push(
      decision({
        action: 'done',
        evidenceText: 'Add Element',
        summary: 'The page has Add Element.'
      })
    )
    const reads = ['', 'heading "Add/Remove" [ref=h1]\nbutton "Add Element" [ref=e1]']
    const session = {
      snapshot: async (): Promise<PlaywrightToolResult> => ({
        text: reads.length > 1 ? (reads.shift() as string) : reads[0]!,
        isError: false
      }),
      call: async (): Promise<PlaywrightToolResult> => ({ text: 'ok', isError: false }),
      recoverPage: async (): Promise<PlaywrightToolResult> => ({ text: 'ok', isError: false })
    } as unknown as PlaywrightMcpSession
    const result = await runBrowserPlaywrightTask({
      goal: 'Read the page',
      plan,
      session,
      guard: new VisionGuard({ taskId: 'web-loading', kind: 'web_use' }),
      activeDriver: () => pointerDriver([]),
      activeUrl: () => 'https://slow.test/',
      waitForUser: async () => undefined,
      takeGuidance: () => [],
      onStep: () => undefined,
      onPhase: () => undefined,
      onProgress: () => undefined
    })
    expect(result.ok).toBe(true)
  })
})
