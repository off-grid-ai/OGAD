/**
 * Release 107 remote-task journey through the real task-history owner, frame encoder and task
 * guard. Electron window/screen objects are the only unavailable OS boundary.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import sharp from 'sharp'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { parseSyncedTaskRun } from '@offgrid/sync'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-remote-task-sync-'))
process.env.OFFGRID_DATA_DIR = root

vi.mock('electron', () => ({
  app: { getPath: () => root, isPackaged: false },
  BrowserWindow: { getAllWindows: () => [] },
  WebContentsView: class {},
  ipcMain: { handle: () => undefined, on: () => undefined },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString()
  }
}))

const taskHistory = await import('../src/main/tasks/task-history')
const { VisionGuard } = await import('../src/main/vision/vision-guard')
const { registerVisionSession } = await import('../src/main/vision/vision-controller')
const {
  observeTaskRunFrame,
  disposeTaskRunFrameProjection,
  evictTerminalTaskRunFrame,
  syncedTaskRunFromSnapshot
} = await import('../pro/main/sync/task-run-projection')
const { applySyncedTaskControl, configureTaskControlSync, disposeTaskControlSync } =
  await import('../pro/main/sync/task-control-sync')

const DEVICE_ID = 'desktop-release-107'

beforeAll(() => {
  taskHistory.configureTaskExecutionDevice({ id: DEVICE_ID, name: 'Studio Mac' })
  configureTaskControlSync(DEVICE_ID, (deviceId) => deviceId === 'mobile-release-107')
})

afterAll(() => {
  disposeTaskRunFrameProjection()
  disposeTaskControlSync()
  taskHistory.resetTaskHistoryForTests()
  fs.rmSync(root, { recursive: true, force: true })
})

describe('a task controlled from its synced Mobile chat', () => {
  it.each(['web_use', 'computer_use'] as const)(
    'pauses the existing %s guard and consumes the direction-safe intent once',
    async (kind) => {
      const taskId = `remote-${kind}`
      const conversationId = `chat-${kind}`
      taskHistory.recordTaskRun({
        taskId,
        journeyId: conversationId,
        kind,
        title: `Run ${kind}`,
        status: 'running',
        executionDeviceId: DEVICE_ID,
        executionDeviceName: 'Studio Mac'
      })
      const guard = new VisionGuard({ taskId, kind })
      const request = new AbortController()
      const release = registerVisionSession(taskId, guard, request)
      const consumed: string[] = []
      const settled: Array<Record<string, unknown>> = []
      const fields = {
        version: 1 as const,
        controlId: `control-${kind}`,
        taskId,
        conversationId,
        executionDeviceId: DEVICE_ID,
        requestingDeviceId: 'mobile-release-107',
        sequence: 1,
        kind: 'pause' as const,
        requestedAt: Date.now()
      }
      const provenance = {
        originDeviceId: 'mobile-release-107',
        originDeviceName: 'Release phone'
      }

      expect(
        applySyncedTaskControl(
          fields.controlId,
          fields,
          provenance,
          (_taskId, result) => settled.push(result),
          (id) => consumed.push(id)
        )
      ).toBe(true)
      expect(guard.isPaused).toBe(true)
      expect(consumed).toEqual([fields.controlId])
      expect(settled).toEqual([
        expect.objectContaining({
          controlId: fields.controlId,
          kind: 'pause',
          outcome: 'applied'
        })
      ])
      expect(
        applySyncedTaskControl(
          fields.controlId,
          fields,
          provenance,
          (_taskId, result) => settled.push(result),
          (id) => consumed.push(id)
        )
      ).toBe(false)
      expect(consumed).toEqual([fields.controlId])
      expect(settled).toHaveLength(1)
      release()
    }
  )

  it.each(['web_use', 'computer_use'] as const)(
    'resumes and then stops the existing %s runtime with correlated receipts',
    (kind) => {
      const taskId = `resume-stop-${kind}`
      const conversationId = `resume-stop-chat-${kind}`
      taskHistory.recordTaskRun({
        taskId,
        journeyId: conversationId,
        kind,
        title: `Resume and stop ${kind}`,
        status: 'paused',
        executionDeviceId: DEVICE_ID,
        executionDeviceName: 'Studio Mac'
      })
      const guard = new VisionGuard({ taskId, kind })
      guard.pause('paused for the integration journey')
      const request = new AbortController()
      const release = registerVisionSession(taskId, guard, request)
      const receipts: Array<Record<string, unknown>> = []
      const control = (controlKind: 'resume' | 'stop', sequence: number): boolean =>
        applySyncedTaskControl(
          `${controlKind}-${kind}`,
          {
            version: 1,
            controlId: `${controlKind}-${kind}`,
            taskId,
            conversationId,
            executionDeviceId: DEVICE_ID,
            requestingDeviceId: 'mobile-release-107',
            sequence,
            kind: controlKind,
            requestedAt: Date.now()
          },
          { originDeviceId: 'mobile-release-107', originDeviceName: 'Release phone' },
          (_settledTaskId, result) => receipts.push(result),
          () => undefined
        )

      expect(control('resume', 1)).toBe(true)
      expect(guard.snapshot().status).toBe('running')
      expect(control('stop', 2)).toBe(true)
      expect(guard.snapshot().status).toBe('stopped')
      expect(request.signal.aborted).toBe(true)
      expect(receipts).toEqual([
        expect.objectContaining({ controlId: `resume-${kind}`, outcome: 'applied' }),
        expect.objectContaining({ controlId: `stop-${kind}`, outcome: 'applied' })
      ])
      release()
    }
  )

  it.each(['web_use', 'computer_use'] as const)(
    'hands the existing %s guard to the Mobile user with Take Over',
    (kind) => {
      const taskId = `takeover-${kind}`
      const conversationId = `takeover-chat-${kind}`
      taskHistory.recordTaskRun({
        taskId,
        journeyId: conversationId,
        kind,
        title: `Take over ${kind}`,
        status: 'running',
        executionDeviceId: DEVICE_ID,
        executionDeviceName: 'Studio Mac'
      })
      const guard = new VisionGuard({ taskId, kind })
      const request = new AbortController()
      const release = registerVisionSession(taskId, guard, request)
      const fields = {
        version: 1 as const,
        controlId: `takeover-control-${kind}`,
        taskId,
        conversationId,
        executionDeviceId: DEVICE_ID,
        requestingDeviceId: 'mobile-release-107',
        sequence: 1,
        kind: 'takeover' as const,
        requestedAt: Date.now()
      }

      expect(
        applySyncedTaskControl(
          fields.controlId,
          fields,
          { originDeviceId: 'mobile-release-107', originDeviceName: 'Release phone' },
          () => undefined,
          () => undefined
        )
      ).toBe(true)
      expect(guard.isPaused).toBe(true)
      expect(guard.snapshot().inputLease.owner).toBe('user')
      release()
    }
  )

  it('rejects a control whose authenticated peer does not match its requesting device', () => {
    const consumed: string[] = []
    expect(
      applySyncedTaskControl(
        'forged-control',
        {
          version: 1,
          controlId: 'forged-control',
          taskId: 'remote-web_use',
          conversationId: 'chat-web_use',
          executionDeviceId: DEVICE_ID,
          requestingDeviceId: 'another-phone',
          sequence: 2,
          kind: 'stop',
          requestedAt: Date.now()
        },
        { originDeviceId: 'mobile-release-107', originDeviceName: 'Release phone' },
        () => undefined,
        (id) => consumed.push(id)
      )
    ).toBe(false)
    expect(consumed).toEqual([])
  })

  it('answers a valid late control once instead of letting the UI infer success', () => {
    taskHistory.recordTaskRun({
      taskId: 'finished-task',
      journeyId: 'finished-chat',
      kind: 'computer_use',
      title: 'Finished task',
      status: 'done',
      executionDeviceId: DEVICE_ID,
      executionDeviceName: 'Studio Mac'
    })
    const results: Array<Record<string, unknown>> = []
    const consumed: string[] = []
    const fields = {
      version: 1 as const,
      controlId: 'late-pause',
      taskId: 'finished-task',
      conversationId: 'finished-chat',
      executionDeviceId: DEVICE_ID,
      requestingDeviceId: 'mobile-release-107',
      sequence: 1,
      kind: 'pause' as const,
      requestedAt: Date.now()
    }
    const apply = (): boolean =>
      applySyncedTaskControl(
        fields.controlId,
        fields,
        { originDeviceId: 'mobile-release-107', originDeviceName: 'Release phone' },
        (_taskId, result) => results.push(result),
        (controlId) => consumed.push(controlId)
      )

    expect(apply()).toBe(true)
    expect(results).toEqual([
      expect.objectContaining({
        controlId: fields.controlId,
        outcome: 'rejected',
        message: 'The task cannot apply this control in its current state.'
      })
    ])
    expect(consumed).toEqual([fields.controlId])
    expect(apply()).toBe(false)
    expect(results).toHaveLength(1)
  })
})

describe('the live Mobile frame projection', () => {
  it('uses the Desktop PiP screenshot and pointer evidence within the wire limits', async () => {
    const taskId = 'computer-live-frame'
    const screenshotPath = path.join(root, 'current-screen.png')
    await sharp({
      create: { width: 1_440, height: 900, channels: 3, background: '#16352c' }
    })
      .png()
      .toFile(screenshotPath)
    taskHistory.recordTaskRun({
      taskId,
      journeyId: 'mobile-chat-live-frame',
      kind: 'computer_use',
      title: 'Send the release message',
      status: 'running',
      executionDeviceId: DEVICE_ID,
      executionDeviceName: 'Studio Mac',
      screenshotPath,
      screenshotDeviceId: DEVICE_ID,
      stepDetails: [
        {
          stepId: 'step-1',
          at: Date.now(),
          phase: 'acting',
          mappedAction: JSON.stringify({ type: 'click', point: { x: 720, y: 450 } }),
          actionCoordinateSpace: 'inference',
          screenshot: {
            path: screenshotPath,
            availability: 'device_local',
            originalWidth: 1_440,
            originalHeight: 900,
            inferenceWidth: 1_440,
            inferenceHeight: 900
          }
        }
      ]
    })
    let fields: Record<string, unknown> | undefined
    observeTaskRunFrame(taskId, (value) => {
      fields = value
    })

    await vi.waitFor(() => expect(fields).toBeDefined())
    const portable = parseSyncedTaskRun(fields)
    expect(portable).toMatchObject({
      taskId,
      conversationId: 'mobile-chat-live-frame',
      kind: 'computer_use',
      executionDevice: { id: DEVICE_ID, name: 'Studio Mac' },
      status: 'running',
      frame: { mimeType: 'image/jpeg' },
      cursor: { x: 480, y: 300 }
    })
    expect(Buffer.from(portable!.frame!.payloadBase64, 'base64').byteLength).toBeLessThanOrEqual(
      512 * 1024
    )
    expect(portable!.frame).toMatchObject({ width: 960, height: 600 })

    const finished = taskHistory.recordTaskRun({
      taskId,
      journeyId: 'mobile-chat-live-frame',
      kind: 'computer_use',
      title: 'Send the release message',
      status: 'done',
      executionDeviceId: DEVICE_ID,
      executionDeviceName: 'Studio Mac'
    })
    expect(evictTerminalTaskRunFrame(taskId)).toBe(true)
    expect(syncedTaskRunFromSnapshot(finished).frame).toBeUndefined()
  })
})
