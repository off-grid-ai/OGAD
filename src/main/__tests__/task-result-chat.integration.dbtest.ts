import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { OffGridApplication } from '@offgrid/application'

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-task-result-chat-'))

vi.mock('electron', () => ({
  app: {
    getPath: () => profile,
    getAppPath: () => process.cwd(),
    isPackaged: false
  },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString()
  },
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: { handle: vi.fn() }
}))

import { createRagConversation, getDB, getRagMessages } from '../database'
import {
  createDesktopAutomationPorts,
  forwardDesktopAutomationEvent,
  recordTaskRun
} from '../tasks/task-history'
import { HOOKS, registerHook, unregisterHook } from '../bootstrap/hookRegistry'

let application: OffGridApplication | undefined
let releaseApplication: (() => void) | undefined
let stopForwarding: (() => void) | undefined

beforeAll(async () => {
  const [{ createOffGridApplication }, { registerDesktopApplication }, modelServices] =
    await Promise.all([
      import('@offgrid/application'),
      import('../composition/application-access'),
      import('../model-services')
    ])
  application = createOffGridApplication({
    models: modelServices.desktopModelWorkspacePorts,
    automation: createDesktopAutomationPorts()
  })
  releaseApplication = registerDesktopApplication(application)
  await application.start()
  stopForwarding = application.automation.events((event) => {
    if (event.type !== 'operation_failed') forwardDesktopAutomationEvent(event)
  })
})

afterAll(async () => {
  stopForwarding?.()
  await application?.stop()
  releaseApplication?.()
  getDB().close()
  fs.rmSync(profile, { recursive: true, force: true })
})

describe('task results in Chat', () => {
  it('offers the committed task snapshot to the optional approval projection', () => {
    const conversationId = 'approved-task-chat'
    createRagConversation(conversationId, 'Approved task')
    const observed: unknown[] = []
    const observe = (snapshot: unknown): void => void observed.push(snapshot)
    registerHook(HOOKS.actionsObserveTaskResult, observe)
    try {
      recordTaskRun({
        taskId: 'approved-task',
        journeyId: conversationId,
        kind: 'web_use',
        title: 'Complete the approved task',
        status: 'done',
        summary: 'The approved task is complete.'
      })
    } finally {
      unregisterHook(HOOKS.actionsObserveTaskResult, observe)
    }

    expect(observed).toMatchObject([
      {
        taskId: 'approved-task',
        journeyId: conversationId,
        status: 'done',
        summary: 'The approved task is complete.'
      }
    ])
  })

  it('adds the verified details and final link to the originating Chat exactly once', () => {
    const conversationId = 'flight-search-chat'
    createRagConversation(conversationId, 'Find a flight')

    const update = {
      taskId: 'flight-search-task',
      journeyId: conversationId,
      kind: 'web_use' as const,
      title: 'Search for the cheapest flight',
      status: 'done' as const,
      summary:
        'Top three options:\n\n1. Airline A — 10:24 AM — 29 hr 31 min — 2 stops — $766\n2. Airline B — 11:20 AM — 26 hr 15 min — 2 stops — $821\n3. Airline C — 5:55 PM — 30 hr 45 min — 2 stops — $831.',
      lastUrl: 'https://www.google.com/travel/flights?trip=one-way&from=SFO&to=PNQ'
    }
    recordTaskRun(update)
    recordTaskRun(update)

    const messages = getRagMessages(conversationId)
    expect(messages).toHaveLength(1)
    const result = messages[0]
    expect(result).toBeDefined()
    expect(result).toMatchObject({
      role: 'assistant',
      content: `${update.summary}\n\n[Open the final page](${update.lastUrl})`
    })
    expect(JSON.parse(result?.context ?? '{}')).toEqual({
      taskResult: {
        taskId: update.taskId,
        kind: update.kind,
        status: 'done',
        url: update.lastUrl
      }
    })
  })

  it('enriches the same result row when the final browser location arrives later', () => {
    const conversationId = 'late-url-chat'
    createRagConversation(conversationId, 'Review a report')
    const base = {
      taskId: 'late-url-task',
      journeyId: conversationId,
      kind: 'web_use' as const,
      title: 'Review a report',
      status: 'done' as const,
      summary: 'The report shows revenue of $42 million.'
    }

    recordTaskRun(base)
    recordTaskRun({ ...base, lastUrl: 'https://example.com/report' })

    const messages = getRagMessages(conversationId)
    expect(messages).toHaveLength(1)
    expect(messages[0]?.content).toBe(
      'The report shows revenue of $42 million.\n\n[Open the final page](https://example.com/report)'
    )
    expect(JSON.parse(messages[0]?.context ?? '{}')).toEqual({
      taskResult: {
        taskId: base.taskId,
        kind: base.kind,
        status: 'done',
        url: 'https://example.com/report'
      }
    })
  })

  it('updates one Chat row from waiting through failure without presenting false success', () => {
    const conversationId = 'unrelated-chat'
    createRagConversation(conversationId, 'Unrelated')
    recordTaskRun({
      taskId: 'failed-task',
      journeyId: conversationId,
      kind: 'web_use',
      title: 'Failed task',
      status: 'waiting',
      currentAction: 'Sign in to continue.'
    })
    expect(getRagMessages(conversationId)).toMatchObject([
      { role: 'assistant', content: 'Waiting for you: Sign in to continue.' }
    ])

    recordTaskRun({
      taskId: 'failed-task',
      journeyId: conversationId,
      kind: 'web_use',
      title: 'Failed task',
      status: 'running'
    })
    expect(getRagMessages(conversationId)).toHaveLength(0)

    recordTaskRun({
      taskId: 'failed-task',
      journeyId: conversationId,
      kind: 'web_use',
      title: 'Failed task',
      status: 'failed',
      summary: 'The report was sent.'
    })

    const messages = getRagMessages(conversationId)
    expect(messages).toHaveLength(1)
    expect(messages[0]).toMatchObject({
      role: 'assistant',
      content: 'Task failed: The report was sent.'
    })
    expect(JSON.parse(messages[0]?.context ?? '{}')).toEqual({
      taskResult: { taskId: 'failed-task', kind: 'web_use', status: 'failed' }
    })
  })

  it('projects stopped tasks but keeps action-owned tasks out of Chat', () => {
    const conversationId = 'stopped-chat'
    createRagConversation(conversationId, 'Stopped task')
    recordTaskRun({
      taskId: 'stopped-task',
      journeyId: conversationId,
      kind: 'computer_use',
      title: 'Send a message',
      status: 'stopped',
      summary: 'Stopped before the message was sent.'
    })
    recordTaskRun({
      taskId: 'action-owned-task',
      journeyId: 'action-owned-task',
      kind: 'computer_use',
      title: 'Action-owned task',
      status: 'done',
      summary: 'This must not appear either.'
    })

    expect(getRagMessages(conversationId)).toMatchObject([
      {
        role: 'assistant',
        content: 'Task stopped: Stopped before the message was sent.'
      }
    ])
  })
})
