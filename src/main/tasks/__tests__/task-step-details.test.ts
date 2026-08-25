import { describe, expect, it } from 'vitest'
import {
  MAX_TASK_STEP_DETAILS,
  boundComputerUseStepDetails,
  sanitizeComputerUseStepDetail
} from '../task-step-details'

describe('Computer Use step observability', () => {
  it('redacts secrets and rejects invalid numeric metadata before persistence', () => {
    const detail = sanitizeComputerUseStepDetail({
      stepId: 'inspect-settings',
      at: Number.NaN,
      modelInput: 'authorization: Bearer visible-token',
      retrievedFacts: ['API_KEY=visible-key'],
      rawResponse: '{"password":"visible-password"}',
      screenshot: {
        originalWidth: Number.POSITIVE_INFINITY,
        originalHeight: 800,
        inferenceWidth: 600,
        inferenceHeight: 400
      },
      execution: { status: 'failed', durationMs: Number.NaN, error: 'access_token=visible' }
    })

    const serialized = JSON.stringify(detail)
    expect(serialized).not.toContain('visible-token')
    expect(serialized).not.toContain('visible-key')
    expect(serialized).not.toContain('visible-password')
    expect(serialized).not.toContain('access_token=visible')
    expect(serialized).not.toContain('NaN')
    expect(serialized).not.toContain('Infinity')
    expect(detail.screenshot).toBeUndefined()
    expect(detail.execution).toEqual({ status: 'failed', error: 'access_token=[redacted]' })
  })

  it('keeps only the newest bounded detail records', () => {
    const details = Array.from({ length: MAX_TASK_STEP_DETAILS + 3 }, (_, index) => ({
      stepId: `step-${index}`,
      at: index
    }))

    const bounded = boundComputerUseStepDetails(details)

    expect(bounded).toHaveLength(MAX_TASK_STEP_DETAILS)
    expect(bounded[0]!.stepId).toBe('step-3')
    expect(bounded.at(-1)?.stepId).toBe(`step-${MAX_TASK_STEP_DETAILS + 2}`)
  })
})
