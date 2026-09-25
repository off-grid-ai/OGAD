import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  axRun: vi.fn(),
  axRouting: vi.fn(),
  configure: vi.fn(),
  guideIpc: vi.fn(),
  handle: vi.fn(),
  initialize: vi.fn(),
  list: vi.fn(),
  remove: vi.fn(),
  retryIpc: vi.fn(),
  viable: vi.fn(),
  visionRun: vi.fn(),
  webRun: vi.fn()
}))

vi.mock('electron', () => ({ ipcMain: { handle: mocks.handle } }))
vi.mock('../tasks/task-history', () => ({
  initializeTaskHistory: mocks.initialize,
  listTaskRuns: mocks.list,
  removeTaskRuns: mocks.remove
}))
vi.mock('../tasks/task-retry-ipc', () => ({ registerTaskRetryIpc: mocks.retryIpc }))
vi.mock('../tasks/task-guide-ipc', () => ({ registerTaskGuideIpc: mocks.guideIpc }))
vi.mock('../tasks/task-retry', () => ({ configureTaskRetryRunner: mocks.configure }))
vi.mock('../vision/vision-controller', () => ({ hasActiveVisionSession: vi.fn(() => false) }))
vi.mock('../browser/browser-host', () => ({
  getBrowserRailHost: () => ({ runTask: mocks.webRun })
}))
vi.mock('../vision/vision-host', () => ({
  getVisionRailHost: () => ({ runTask: mocks.visionRun })
}))
vi.mock('../accessibility/ax-host', () => ({
  getAxRailHost: () => ({ routingSnapshot: mocks.axRouting, runTask: mocks.axRun })
}))
vi.mock('../accessibility/ax-router', () => ({ axRailViable: mocks.viable }))

import { registerTaskHistoryIpc } from '../tasks/task-history-ipc'

beforeEach(() => {
  vi.clearAllMocks()
  mocks.list.mockReturnValue([{ taskId: 'task-1' }])
  mocks.remove.mockReturnValue(['task-1'])
  mocks.webRun.mockResolvedValue({ ok: true })
  mocks.visionRun.mockResolvedValue({ ok: true, performedActions: [{ type: 'key' }] })
  mocks.axRun.mockResolvedValue({ ok: true })
})

describe('task history IPC composition', () => {
  it('registers list and remove handlers with validated arguments', () => {
    const handlers = new Map<string, (...args: unknown[]) => unknown>()
    mocks.handle.mockImplementation((channel, handler) => handlers.set(channel, handler))

    registerTaskHistoryIpc()

    expect(handlers.get('tasks:list')?.({}, 5)).toEqual([{ taskId: 'task-1' }])
    expect(handlers.get('tasks:list')?.({}, 'all')).toEqual([{ taskId: 'task-1' }])
    expect(handlers.get('tasks:remove')?.({}, ['task-1', 42])).toEqual(['task-1'])
    expect(handlers.get('tasks:remove')?.({}, null)).toEqual(['task-1'])
    expect(mocks.initialize).toHaveBeenCalledOnce()
    expect(mocks.retryIpc).toHaveBeenCalledOnce()
    expect(mocks.guideIpc).toHaveBeenCalledOnce()
  })

  it('routes retry work through web, AX, and vision hosts', async () => {
    registerTaskHistoryIpc()
    const runner = mocks.configure.mock.calls[0]?.[0]
    const task = { title: 'Open item', journeyId: 'journey-1', lastUrl: 'https://example.com' }
    const checkpoint = { taskId: 'task-1', steps: [], summary: 'retry', currentStep: 1 }

    await runner.web(task, 'task-1', checkpoint)
    expect(mocks.webRun).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: 'task-1', checkpoint })
    )

    mocks.axRouting.mockResolvedValueOnce({
      app: 'Notes',
      snapshot: { windowTitle: 'Notes', elements: [] }
    })
    mocks.viable.mockReturnValueOnce(true)
    await runner.computer(task, 'task-1', checkpoint)
    const recovery = mocks.axRun.mock.calls[0]?.[4].recoverWithVision
    await expect(recovery(checkpoint, { specialistOnly: true })).resolves.toMatchObject({
      ok: true,
      effectId: 'task-1',
      performedActions: [{ type: 'key' }]
    })

    mocks.axRouting.mockResolvedValueOnce(null)
    await runner.computer(task, 'task-2', checkpoint)
    expect(mocks.visionRun).toHaveBeenCalled()
  })
})
