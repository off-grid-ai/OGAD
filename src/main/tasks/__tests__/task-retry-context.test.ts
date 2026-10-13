// Continue runs in the same task context as a new run of its kind. Electron, the hosts and the
// settings stores are the boundaries replaced; the gate and the task session run for real.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { TaskRetryRunResult } from '../task-retry'

const world = vi.hoisted(() => ({
  runner: null as null | {
    web: (task: unknown, taskId: string, checkpoint?: unknown) => Promise<TaskRetryRunResult>
    computer: (task: unknown, taskId: string, checkpoint?: unknown) => Promise<TaskRetryRunResult>
  },
  seen: [] as Array<{ taskKind?: string; modelStrategy?: string }>
}))

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  app: { getPath: () => '/tmp/offgrid-task-retry-context' }
}))
vi.mock('node:fs/promises', () => ({
  appendFile: vi.fn(async () => undefined),
  mkdir: vi.fn(async () => undefined),
  stat: vi.fn(async () => ({ size: 0 }))
}))
vi.mock('../task-history', () => ({
  initializeTaskHistory: vi.fn(),
  listTaskRuns: vi.fn(),
  removeTaskRuns: vi.fn()
}))
vi.mock('../task-retry', () => ({
  configureTaskRetryRunner: (runner: typeof world.runner) => {
    world.runner = runner
  }
}))
vi.mock('../../web-use-settings', () => ({
  getWebUseSettings: () => ({ modelStrategy: 'separate_specialist', decisionModelId: null })
}))
vi.mock('../../computer-use-settings', () => ({
  getComputerUseSettings: () => ({ modelStrategy: 'same_as_chat', decisionModelId: null })
}))
vi.mock('../../vision/remote-vision-server', () => ({
  getActiveRemoteVisionServer: () => null,
  getRemoteVisionServerForModel: () => null
}))
vi.mock('../../vision/grounder-loader', () => ({ selectedGrounderModelId: () => null }))
vi.mock('../../accessibility/decision-model-loader', () => ({
  selectedDecisionModelId: () => null
}))
vi.mock('../../vision/vision-controller', () => ({
  forgetVisionStopBeforeStart: vi.fn(),
  hasActiveVisionSession: () => false
}))
vi.mock('../../browser/web-use-host', async () => {
  const { currentRemoteScreenTaskSession } = await import('../../actions/remote-screen-session')
  return {
    getWebUseRailHost: () => ({
      runTask: async () => {
        world.seen.push({ ...currentRemoteScreenTaskSession() })
        return { ok: true, summary: 'Found the release notes' }
      }
    })
  }
})

import { registerTaskHistoryIpc } from '../task-history-ipc'

const task = { title: 'Find the release notes', lastUrl: 'https://example.com', journeyId: 'j-1' }

beforeEach(() => {
  world.seen = []
  registerTaskHistoryIpc()
})

describe('Continue', () => {
  it('runs a web task with the Web Use model settings, never the Computer Use ones', async () => {
    const result = await world.runner!.web(task, 'task-1')
    expect(result).toEqual({ ok: true, summary: 'Found the release notes' })
    expect(world.seen).toEqual([
      expect.objectContaining({ taskKind: 'web_use', modelStrategy: 'separate_specialist' })
    ])
  })
})
