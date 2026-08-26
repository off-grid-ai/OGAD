/**
 * Real guidance attachment journey through the task-history database, extraction
 * pipeline, in-memory running-task handler, and durable privacy projection. Only
 * Electron's OS boundary is replaced with a temporary profile.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-task-guide-attachments-'))

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

import { getDB } from '../database'
import {
  appendTaskStep,
  getTaskRun,
  recordTaskRun,
  resetTaskHistoryForTests
} from '../tasks/task-history'
import {
  guideTask,
  persistedTaskGuidanceTrace,
  registerTaskGuideHandler,
  resetTaskGuideHandlersForTests
} from '../tasks/task-guide'
import {
  TASK_GUIDE_MAX_ATTACHMENTS,
  TASK_GUIDE_MAX_ATTACHMENT_BYTES,
  TASK_GUIDE_MAX_TOTAL_ATTACHMENT_BYTES,
  type TaskGuideInput
} from '../../shared/task-guidance'

afterEach(() => {
  resetTaskGuideHandlersForTests()
})

afterAll(() => {
  resetTaskHistoryForTests()
  getDB().close()
  fs.rmSync(profile, { recursive: true, force: true })
})

function runningTask(taskId: string): void {
  recordTaskRun({
    taskId,
    kind: 'web_use',
    title: 'Prepare the release note',
    status: 'running'
  })
}

function waitingTask(taskId: string): void {
  recordTaskRun({
    taskId,
    kind: 'web_use',
    title: 'Wait for route details',
    status: 'waiting'
  })
}

describe('live task guidance attachments', () => {
  it('accepts guidance while a live task waits for user input', async () => {
    const taskId = 'web-guidance-waiting'
    waitingTask(taskId)
    let received = ''
    registerTaskGuideHandler(taskId, (guidance) => {
      received = guidance
      return true
    })

    await expect(
      guideTask(taskId, { text: 'SFO to Pune on September 1', attachments: [] })
    ).resolves.toMatchObject({
      available: true,
      accepted: true
    })
    expect(received).toBe('SFO to Pune on September 1')
  })

  it('keeps one accepted trace when the live operator records it first', async () => {
    const taskId = 'web-guidance-single-owner'
    waitingTask(taskId)
    registerTaskGuideHandler(taskId, () => {
      appendTaskStep(taskId, 'web_use', 'Wait for route details', persistedTaskGuidanceTrace())
      return true
    })

    await expect(guideTask(taskId, { text: 'Use a one-way flight' })).resolves.toMatchObject({
      accepted: true
    })
    expect(
      getTaskRun(taskId)?.steps.filter((step) => step === persistedTaskGuidanceTrace())
    ).toHaveLength(1)
  })

  it('extracts a selected file for the next decision without persisting its contents or path', async () => {
    const taskId = 'web-guidance-attachment'
    runningTask(taskId)
    let received = ''
    registerTaskGuideHandler(taskId, (guidance) => {
      received = guidance
      return true
    })
    const privateText = 'Use account 839201 and the short release title.'
    const attachmentSecret = 'Internal launch phrase: blue-orchid-71.'
    const input: TaskGuideInput = {
      text: privateText,
      attachments: [
        {
          name: '/Users/private/Documents/release-notes.txt',
          mimeType: 'text/plain',
          bytes: new TextEncoder().encode(attachmentSecret)
        }
      ]
    }

    await expect(guideTask(taskId, input)).resolves.toMatchObject({
      available: true,
      accepted: true
    })
    expect(received).toContain(privateText)
    expect(received).toContain('release-notes.txt')
    expect(received).toContain(attachmentSecret)
    expect(received).not.toContain('/Users/private')

    const durable = JSON.stringify(getTaskRun(taskId))
    expect(durable).not.toContain(privateText)
    expect(durable).not.toContain(attachmentSecret)
    expect(durable).not.toContain('/Users/private')
    expect(durable).toContain('GUIDANCE ACCEPTED')
    expect(fs.existsSync(path.join(profile, 'uploads'))).toBe(false)
  })

  it('rejects unsafe types and oversized bytes before the running task sees them', async () => {
    const taskId = 'web-guidance-rejected-attachment'
    runningTask(taskId)
    let deliveries = 0
    registerTaskGuideHandler(taskId, () => {
      deliveries += 1
      return true
    })

    await expect(
      guideTask(taskId, {
        text: '',
        attachments: [
          { name: 'installer.command', bytes: new TextEncoder().encode('do not run this') }
        ]
      })
    ).resolves.toMatchObject({
      accepted: false,
      reason: expect.stringContaining('not a supported guidance attachment')
    })

    await expect(
      guideTask(taskId, {
        text: '',
        attachments: [
          { name: 'too-large.txt', bytes: new Uint8Array(TASK_GUIDE_MAX_ATTACHMENT_BYTES + 1) }
        ]
      })
    ).resolves.toMatchObject({
      accepted: false,
      reason: expect.stringContaining('larger than 5 MB')
    })

    await expect(
      guideTask(taskId, {
        text: '',
        attachments: Array.from({ length: TASK_GUIDE_MAX_ATTACHMENTS + 1 }, (_, index) => ({
          name: `note-${index}.txt`,
          bytes: new Uint8Array([index])
        }))
      })
    ).resolves.toMatchObject({
      accepted: false,
      reason: expect.stringContaining(`up to ${TASK_GUIDE_MAX_ATTACHMENTS} files`)
    })

    const third = Math.floor(TASK_GUIDE_MAX_TOTAL_ATTACHMENT_BYTES / 3) + 1
    await expect(
      guideTask(taskId, {
        text: '',
        attachments: Array.from({ length: 3 }, (_, index) => ({
          name: `large-note-${index}.txt`,
          bytes: new Uint8Array(third)
        }))
      })
    ).resolves.toMatchObject({
      accepted: false,
      reason: expect.stringContaining('total 12 MB or less')
    })
    expect(deliveries).toBe(0)
  })
})
