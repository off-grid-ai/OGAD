import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3-multiple-ciphers'
import { describe, expect, it } from 'vitest'
import { UseEngine } from '@offgrid/use'
import { makeUseDriver } from '../actions/use-driver'
import { buildRegistry } from '../actions/use-runtime'
import { createActionWorker } from '../actions/use-worker'
import { gateHost, onGateParked, whenActionParked, resolveActionGate } from '../actions/gate-host'
import { HOOKS, registerHook, unregisterHook } from '../bootstrap/hookRegistry'
import { NativeActionToolExtension } from '../tools/nativeActionToolExtension'
import type { NativeActionCommand, NativeActionResponse } from '../actions/native-helper-logic'

describe('browser native action approval with the real engine', () => {
  // Browser changes wait for Desktop approval. A web task runs in its owning Chat;
  // without a conversation ID, either origin must use the approval surface.
  it.each([
    ['mail_send', true, 'bridge', 'browser-chat'],
    ['messages_send', true, 'bridge', 'browser-chat'],
    ['calendar_create_event', true, 'bridge', 'browser-chat'],
    ['reminders_create', true, 'bridge', 'browser-chat'],
    ['open_url', false, 'bridge', 'browser-chat'],
    ['web_use', true, 'bridge', undefined],
    ['web_use', true, 'desktop', undefined],
    ['web_use', false, 'bridge', 'browser-chat'],
    ['web_use', false, 'desktop', 'desktop-chat']
  ] as const)('%s waits: %s (%s, %s)', async (name, waits, origin, conversationId) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-native-approval-'))
    const db = new Database(path.join(root, 'actions.db'))
    const executed: unknown[] = []
    const requests: Array<{ actionId: string }> = []
    const run = async (command: NativeActionCommand): Promise<NativeActionResponse> => {
      executed.push(command)
      return { ok: false, error: 'No native operation was expected' }
    }
    const engine = new UseEngine({
      driver: makeUseDriver(db),
      registry: buildRegistry(run),
      device: {
        execute: async (action) => {
          executed.push(action)
          return { ok: false, detail: 'No device action was expected' }
        }
      },
      gate: gateHost
    })
    const worker = createActionWorker(engine, { onParked: onGateParked })
    // The approval UI accepts the request and waits for the user's decision.
    registerHook(HOOKS.actionsProposeApproval, (request: { actionId: string }) => {
      requests.push(request)
      return true
    })
    try {
      await engine.init()
      const extension = new NativeActionToolExtension(
        {
          run,
          taskUseEnabled: () => true,
          actions: {
            propose: (input, meta) => engine.propose(input, meta),
            waitForOutcome: (id, timeout) => worker.waitForOutcome(id, timeout),
            whenParked: whenActionParked,
            kick: () => worker.kick()
          }
        },
        'darwin'
      )
      const result = await extension.execute(
        name,
        {
          to: 'test@example.test',
          text: 'Synthetic message',
          body: 'Synthetic message',
          title: 'Synthetic event',
          start: '2026-10-12T12:00:00Z',
          url: 'https://example.test',
          goal: 'Read the page'
        },
        { origin, acting: true, conversationId }
      )
      const text = typeof result === 'string' ? result : result.text
      if (waits) {
        // Task tools return on acceptance; the real gate determines whether they can run.
        if (name !== 'web_use') {
          expect(text).toMatch(/waiting for the user's approval in Off Grid AI Desktop/i)
        }
        await expect.poll(() => requests.length).toBe(1)
        expect(executed).toEqual([])
      } else {
        expect(text).not.toMatch(/waiting for the user's approval/i)
        await expect.poll(() => executed.length).toBeGreaterThan(0)
        expect(requests).toEqual([])
      }
    } finally {
      for (const request of requests) {
        const finished = worker.waitForOutcome(request.actionId, 2_000)
        resolveActionGate(request.actionId, { kind: 'reject', reason: 'Test user declined' })
        expect((await finished)?.outcome).toBe('rejected')
      }
      await expect.poll(() => worker.draining()).toBe(false)
      unregisterHook(HOOKS.actionsProposeApproval)
      db.close()
      fs.rmSync(root, { recursive: true, force: true })
    }
    // A declined action never runs; a Chat-owned task and link run without asking.
    if (waits) expect(executed).toEqual([])
    else expect(executed).not.toEqual([])
  })
})
