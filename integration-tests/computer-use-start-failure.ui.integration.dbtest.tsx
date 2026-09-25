// @vitest-environment jsdom

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import React from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import { afterAll, describe, expect, it, vi } from 'vitest'

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-computer-use-start-failure-'))
const previousDataDir = process.env.OFFGRID_DATA_DIR
process.env.OFFGRID_DATA_DIR = profile

vi.mock('electron', () => ({
  app: { getPath: () => profile, isPackaged: false, getAppPath: () => process.cwd() },
  BrowserWindow: { getAllWindows: () => [] },
  globalShortcut: { register: () => false, unregister: () => undefined },
  ipcMain: { handle: () => undefined },
  screen: { getAllDisplays: () => [{}] },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString()
  },
  systemPreferences: {
    getMediaAccessStatus: () => 'granted',
    isTrustedAccessibilityClient: () => false
  }
}))

afterAll(() => {
  cleanup()
  if (previousDataDir === undefined) delete process.env.OFFGRID_DATA_DIR
  else process.env.OFFGRID_DATA_DIR = previousDataDir
  fs.rmSync(profile, { recursive: true, force: true })
})

describe('Computer Use task history after a start failure', () => {
  it('shows a failed task when Accessibility permission blocks a normal run', async () => {
    const taskId = 'computer-use-permission-check'
    const goal = 'Draft an email in Mail'
    const taskHistory = await import('../src/main/tasks/task-history')
    const { getAxRailHost } = await import('../src/main/accessibility/ax-host')
    const { TaskHistoryList } =
      await import('../pro/renderer/components/browser/tasks/TaskHistoryList')

    const outcome = await getAxRailHost().runTask(goal, taskId, 'Mail', {
      windowTitle: 'New Message',
      elements: []
    })
    const task = taskHistory.getTaskRun(taskId)!

    expect(outcome.ok).toBe(false)
    expect(task.status).toBe('failed')
    render(
      React.createElement(TaskHistoryList, {
        tasks: [task],
        active: task,
        expandedTaskId: null,
        onOpenDetails: () => undefined,
        onCloseDetails: () => undefined,
        onRetryStarted: () => undefined
      })
    )

    expect(screen.getByTestId(`task-tab-${taskId}`).textContent).toContain('failed')
    expect(screen.queryByText('running')).toBeNull()
  }, 15_000)
})
