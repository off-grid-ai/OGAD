import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ appendComputerUseStepDetail: vi.fn() }))

vi.mock('../../tasks/task-history', () => ({
  appendComputerUseStepDetail: mocks.appendComputerUseStepDetail
}))

import { persistAxObservation } from '../ax-observation'

describe('persistAxObservation', () => {
  beforeEach(() => mocks.appendComputerUseStepDetail.mockReset())

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
