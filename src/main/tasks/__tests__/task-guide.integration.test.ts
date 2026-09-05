/**
 * Desktop task guidance and history bindings over the REAL Shared automation application.
 * `task-guide.ts` and `task-history.ts` forward to the one `AutomationApplication` the Shared root
 * constructs; here that application is built through the desktop ports (real SQLite history in a
 * throwaway profile, this machine as the execution device) and driven through the desktop
 * function API its IPC hosts import. Only Electron is faked, at the process boundary.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { OffGridApplication } from '@offgrid/application'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-task-guide-integration-'))

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

const { getDB } = await import('../../database')
const { guideTask, registerTaskGuideHandler, taskGuideAvailability, TASK_GUIDANCE_TRACE } =
  await import('../task-guide')
const {
  configureTaskRetryRunner,
  createDesktopAutomationPorts,
  getTaskExecutionDevice,
  getTaskRun,
  listTaskRuns,
  recordTaskRun,
  stopOrphanedLocalWebTask
} = await import('../task-history')
const { desktopAutomation, registerDesktopApplication } =
  await import('../../composition/application-access')

let application: OffGridApplication
let releaseApplication: () => void

beforeAll(async () => {
  const [{ createOffGridApplication }, { desktopModelWorkspacePorts }] = await Promise.all([
    import('@offgrid/application'),
    import('../../model-services')
  ])
  application = createOffGridApplication({
    models: desktopModelWorkspacePorts,
    automation: createDesktopAutomationPorts()
  })
  releaseApplication = registerDesktopApplication(application)
  await application.start()
})

afterAll(async () => {
  await application.stop()
  releaseApplication()
  getDB().close()
  fs.rmSync(profile, { recursive: true, force: true })
})

function runningWebTask(
  taskId: string,
  journeyId = `chat-${taskId}`
): ReturnType<typeof recordTaskRun> {
  const device = getTaskExecutionDevice()
  return recordTaskRun({
    taskId,
    journeyId,
    kind: 'web_use',
    title: `Task ${taskId}`,
    status: 'running',
    executionDeviceId: device.id,
    executionDeviceName: device.name
  })
}

describe('task history through the desktop ports', () => {
  it('names this computer as the execution device', () => {
    const device = getTaskExecutionDevice()
    expect(device.id).toBe(`desktop:${os.hostname()}`)
    expect(device.name).toBe(os.hostname() || 'This computer')
  })

  it('records a run, reads it back, and lists newest first within a limit', () => {
    const first = runningWebTask('history-1')
    expect(first.status).toBe('running')
    expect(getTaskRun('history-1')).toMatchObject({ taskId: 'history-1', title: 'Task history-1' })
    expect(getTaskRun('never-recorded')).toBeUndefined()

    recordTaskRun({
      taskId: 'history-2',
      kind: 'computer_use',
      title: 'Task history-2',
      status: 'done',
      summary: 'Finished'
    })
    const ids = listTaskRuns().map((task) => task.taskId)
    expect(ids).toEqual(expect.arrayContaining(['history-1', 'history-2']))
    expect(ids.indexOf('history-2')).toBeLessThan(ids.indexOf('history-1'))
    expect(listTaskRuns(1)).toHaveLength(1)
  })

  it('persists runs in the profile database, not the working directory', () => {
    const rows = getDB()
      .prepare('SELECT task_id FROM task_run_history WHERE task_id = ?')
      .all('history-1') as Array<{ task_id: string }>
    expect(rows.map((row) => row.task_id)).toEqual(['history-1'])
    expect(fs.existsSync(path.join(profile, 'memories.db'))).toBe(true)
  })

  it('stops only a live local Web Use task whose browser owner is gone', () => {
    runningWebTask('orphan-local')
    expect(stopOrphanedLocalWebTask('orphan-local')).toBe(true)
    expect(getTaskRun('orphan-local')).toMatchObject({
      status: 'stopped',
      summary: 'Stopped because the earlier local Web Use process is no longer active.'
    })
    // Already terminal: nothing to stop.
    expect(stopOrphanedLocalWebTask('orphan-local')).toBe(false)

    recordTaskRun({
      taskId: 'orphan-remote',
      kind: 'web_use',
      title: 'Remote task',
      status: 'running',
      executionDeviceId: 'mobile-9',
      executionDeviceName: 'Phone'
    })
    expect(stopOrphanedLocalWebTask('orphan-remote')).toBe(false)
    expect(getTaskRun('orphan-remote')?.status).toBe('running')

    recordTaskRun({
      taskId: 'orphan-native',
      kind: 'computer_use',
      title: 'Native task',
      status: 'running'
    })
    expect(stopOrphanedLocalWebTask('orphan-native')).toBe(false)
    expect(stopOrphanedLocalWebTask('orphan-unknown')).toBe(false)
  })
})

describe('task retry runner binding', () => {
  function failedTask(taskId: string): void {
    const device = getTaskExecutionDevice()
    recordTaskRun({
      taskId,
      journeyId: `chat-${taskId}`,
      kind: 'web_use',
      title: `Task ${taskId}`,
      status: 'failed',
      summary: 'Lost the page',
      executionDeviceId: device.id,
      executionDeviceName: device.name
    })
  }

  it('refuses to retry before the composition root binds a runner', () => {
    failedTask('retry-unbound')
    expect(desktopAutomation.retryAvailability('retry-unbound')).toMatchObject({ available: true })
    expect(() => desktopAutomation.retry('retry-unbound')).toThrow(
      'Task retry runner is not configured.'
    )
  })

  it('resumes on the bound runner from the failed checkpoint', async () => {
    const seen: Array<{ surface: 'web' | 'computer'; taskId: string; steps: readonly string[] }> =
      []
    configureTaskRetryRunner({
      web: async (_task, taskId, checkpoint) => {
        seen.push({ surface: 'web', taskId, steps: checkpoint.steps })
        return { ok: true, summary: 'Found the page again' }
      },
      computer: async (_task, taskId, checkpoint) => {
        seen.push({ surface: 'computer', taskId, steps: checkpoint.steps })
        return { ok: false, summary: 'Screen unavailable' }
      }
    })

    failedTask('retry-web')
    const result = desktopAutomation.retry('retry-web')
    expect(result).toMatchObject({ available: true, taskId: 'retry-web', journeyId: 'chat-retry-web' })
    await vi.waitFor(() => expect(getTaskRun('retry-web')?.status).toBe('done'))
    expect(getTaskRun('retry-web')?.summary).toBe('Found the page again')
    expect(seen).toEqual([{ surface: 'web', taskId: 'retry-web', steps: [] }])

    const device = getTaskExecutionDevice()
    recordTaskRun({
      taskId: 'retry-native',
      journeyId: 'chat-retry-native',
      kind: 'computer_use',
      title: 'Native task',
      status: 'failed',
      executionDeviceId: device.id,
      executionDeviceName: device.name
    })
    desktopAutomation.retry('retry-native')
    await vi.waitFor(() => expect(getTaskRun('retry-native')?.status).toBe('failed'))
    expect(getTaskRun('retry-native')?.summary).toBe('Screen unavailable')
    expect(seen[1]).toMatchObject({ surface: 'computer', taskId: 'retry-native' })
  })
})

describe('task guidance through the desktop binding', () => {
  it('is unavailable for tasks that are unknown, finished, or without a live handler', async () => {
    expect(taskGuideAvailability('guide-missing').available).toBe(false)
    expect((await guideTask('guide-missing', { text: 'Go left' })).available).toBe(false)

    recordTaskRun({ taskId: 'guide-done', kind: 'web_use', title: 'Done', status: 'done' })
    expect(taskGuideAvailability('guide-done').available).toBe(false)

    runningWebTask('guide-no-handler')
    expect(taskGuideAvailability('guide-no-handler')).toEqual({
      available: false,
      reason: 'This task cannot accept guidance yet.'
    })
  })

  it('hands the exact text to the live handler and persists only the safe trace', async () => {
    runningWebTask('guide-live')
    const received: string[] = []
    const release = registerTaskGuideHandler('guide-live', (text) => {
      received.push(text)
      return true
    })
    expect(taskGuideAvailability('guide-live')).toEqual({ available: true })

    const privateText = 'Use password=hunter2 on the login form'
    await expect(guideTask('guide-live', { text: privateText })).resolves.toEqual({
      available: true,
      accepted: true
    })
    expect(received).toEqual([privateText])

    const stored = getTaskRun('guide-live')
    expect(stored?.steps).toContain(TASK_GUIDANCE_TRACE)
    expect(JSON.stringify(stored)).not.toContain('hunter2')
    const row = getDB()
      .prepare('SELECT steps_json AS steps FROM task_run_history WHERE task_id = ?')
      .get('guide-live') as { steps: string }
    expect(row.steps).not.toContain('hunter2')

    release()
    expect(taskGuideAvailability('guide-live').available).toBe(false)
  })

  it('rejects empty text before reaching the handler, and reports a handler refusal', async () => {
    runningWebTask('guide-refuse')
    const handler = vi.fn(() => false)
    const release = registerTaskGuideHandler('guide-refuse', handler)

    const empty = await guideTask('guide-refuse', { text: '   ' })
    expect(empty.available).toBe(false)
    expect(empty.reason).toBeTruthy()
    expect(handler).not.toHaveBeenCalled()

    await expect(guideTask('guide-refuse', { text: 'Try the other button' })).resolves.toEqual({
      available: true,
      accepted: false,
      reason: 'The running task did not accept this guidance.'
    })
    expect(getTaskRun('guide-refuse')?.steps ?? []).not.toContain(TASK_GUIDANCE_TRACE)
    release()
  })
})
