/**
 * Focused Web Use control journeys. Off Grid policy, lifecycle, and action
 * dispatch are real. Only the remote model, Playwright MCP, and pointer driver
 * boundaries are faked.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

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

import { runBrowserPlaywrightTask } from '../browser-playwright-task'
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
})

describe('Web Use shared lifecycle', () => {
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
})
