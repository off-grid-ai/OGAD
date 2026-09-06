import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  appendComputerUseStepDetail: vi.fn(),
  getTaskExecutionDevice: vi.fn(() => ({ id: 'mac-1', name: 'My Mac' })),
  recordTaskRun: vi.fn()
}))

vi.mock('../../tasks/task-history', () => ({
  appendComputerUseStepDetail: mocks.appendComputerUseStepDetail,
  getTaskExecutionDevice: mocks.getTaskExecutionDevice,
  recordTaskRun: mocks.recordTaskRun
}))

import { persistAxFrame, persistAxObservation } from '../ax-observation'

describe('persistAxObservation', () => {
  beforeEach(() => {
    mocks.appendComputerUseStepDetail.mockReset()
    mocks.recordTaskRun.mockReset()
  })

  it('makes a captured frame durable before later task progress can prune it', () => {
    persistAxFrame({
      taskId: 'task-6',
      journeyId: 'chat-6',
      title: 'Send the message',
      frame: {
        capture: {
          path: '/captures/task-6.png',
          width: 1280,
          height: 720,
          displayBounds: { x: 0, y: 0, width: 2560, height: 1440 }
        },
        snapshot: { windowTitle: 'WhatsApp', elements: [] }
      }
    })

    expect(mocks.recordTaskRun).toHaveBeenCalledWith({
      taskId: 'task-6',
      journeyId: 'chat-6',
      kind: 'computer_use',
      title: 'Send the message',
      screenshotPath: '/captures/task-6.png',
      screenshotDeviceId: 'mac-1',
      executionDeviceId: 'mac-1',
      executionDeviceName: 'My Mac'
    })
  })

  it('writes bounded task evidence through the shared history adapter without a screenshot', () => {
    persistAxObservation('task-7', 'Send the message', {
      step: 2,
      prompt: 'exact AX prompt',
      retrievedFacts: ['Earlier task opened Slack'],
      rawResponse: '{"action":"press","index":4}',
      parsedAction: { action: 'press', index: 4 },
      durationMs: 31,
      result: 'actuated'
    })

    expect(mocks.appendComputerUseStepDetail).toHaveBeenCalledOnce()
    expect(mocks.appendComputerUseStepDetail).toHaveBeenCalledWith(
      'task-7',
      'Send the message',
      expect.objectContaining({
        stepId: '2',
        retrievedFacts: ['Earlier task opened Slack'],
        rawResponse: '{"action":"press","index":4}',
        mappedAction: '{"action":"press","index":4}',
        execution: {
          status: 'complete',
          durationMs: 31,
          result: 'actuated',
          error: undefined
        }
      })
    )
    expect(mocks.appendComputerUseStepDetail.mock.calls[0]?.[2]).not.toHaveProperty('screenshot')
  })

  it('marks execution errors as failed', () => {
    persistAxObservation('task-8', 'Open settings', {
      step: 1,
      prompt: 'prompt',
      retrievedFacts: [],
      rawResponse: '{"action":"click","index":1}',
      parsedAction: { action: 'click', index: 1 },
      durationMs: 12,
      result: 'error',
      error: 'input driver stopped'
    })

    expect(mocks.appendComputerUseStepDetail.mock.calls[0]?.[2].execution).toEqual({
      status: 'failed',
      durationMs: 12,
      result: 'error',
      error: 'input driver stopped'
    })
  })
})
