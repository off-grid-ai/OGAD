import { describe, expect, it } from 'vitest'
import {
  MAX_TASK_STEP_DETAILS,
  boundComputerUseStepDetails,
  sanitizeComputerUseStepDetail
} from '../task-step-details'

describe('Computer Use step observability', () => {
  it('drops empty model sentinel values before persistence', () => {
    const detail = sanitizeComputerUseStepDetail({
      stepId: '1',
      decisionSummary: 'null',
      mappedAction: 'undefined'
    })

    expect(detail).not.toHaveProperty('decisionSummary')
    expect(detail).not.toHaveProperty('mappedAction')
  })

  it('redacts secrets and rejects invalid numeric metadata before persistence', () => {
    const detail = sanitizeComputerUseStepDetail({
      stepId: 'inspect-settings',
      at: Number.NaN,
      // Still passed in, deliberately: callers may hand over a prompt echo, and the point is that
      // it is DROPPED rather than stored - it was 73% of the task payload on every list poll, and
      // dropping it must also drop anything sensitive that rode inside it.
      modelInput:
        'authorization: Bearer visible-token\n<think>prior hidden reasoning</think>\nAction: click settings',
      retrievedFacts: ['API_KEY=visible-key'],
      decisionSummary: 'Open Settings',
      decisionRationale: 'The Settings control matches the current task stage.',
      rawResponse:
        '<think>private chain of thought</think><action>Open Settings</action><tool_call>{"password":"visible-password"}</tool_call>',
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
    expect(serialized).not.toContain('private chain of thought')
    expect(serialized).not.toContain('prior hidden reasoning')
    expect('modelInput' in detail).toBe(false)
    expect(serialized).not.toContain('Action: click settings')
    expect(detail.decisionSummary).toBe('Open Settings')
    expect(detail.decisionRationale).toBe('The Settings control matches the current task stage.')
    expect(detail.modelOutput).toContain('<action>Open Settings</action>')
    expect(detail).not.toHaveProperty('rawResponse')
    expect(serialized).not.toContain('access_token=visible')
    expect(serialized).not.toContain('NaN')
    expect(serialized).not.toContain('Infinity')
    expect(detail.screenshot).toBeUndefined()
    expect(detail.execution).toEqual({ status: 'failed', error: 'access_token=[redacted]' })
  })

  it('removes an untagged UI-TARS Thought preface but keeps its action', () => {
    const detail = sanitizeComputerUseStepDetail({
      stepId: 'click-send',
      at: 1,
      rawResponse:
        'Thought: I should inspect every private possibility before choosing.\nAction: click(point="640 900")'
    })

    expect(detail.modelOutput).toBe('Action: click(point="640 900")')
    expect(JSON.stringify(detail)).not.toContain('private possibility')
  })

  it('never persists text entered by a Computer Use action', () => {
    const detail = sanitizeComputerUseStepDetail({
      stepId: 'enter-code',
      at: 1,
      modelInput: "Action: type(content='prior-secret')",
      rawResponse: "Thought: use the supplied code\nAction: type(content='839201')",
      decisionSummary: 'type "decision-secret"',
      mappedAction: '{"type":"type","content":"hunter2"}'
    })

    const serialized = JSON.stringify(detail)
    expect(serialized).not.toContain('prior-secret')
    expect(serialized).not.toContain('839201')
    expect(serialized).not.toContain('decision-secret')
    expect(serialized).not.toContain('hunter2')
    expect(detail.modelOutput).toBe("Action: type(content='[redacted]')")
    expect(detail.mappedAction).toContain('[redacted]')
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
