import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { llm } from '../../llm'
import {
  generalVisionOperatorAdapter,
  generalStepDecisionFailure,
  parseGeneralStepDecision,
  parseGeneralVisionOperatorResponse
} from '../model-adapters/general-vision-operator'
import { resolveVisionModelAdapter } from '../model-adapters/registry'
import { uiTarsAdapter } from '../model-adapters/ui-tars'
import { UI_MATE_GGUF_REPOSITORY } from '../model-adapters/ui-mate/capabilities'
import {
  answerAfterThinking,
  createVisionGrounder,
  normalizedPolicyAnswer,
  remoteVisionProviderError,
  remoteVisionTransportError,
  visionPolicyMessagesForAttempt,
  runVisionPolicyRequest
} from '../vision-policy-runner'

const gemmaModel = {
  id: 'unsloth/gemma-4-E4B-it-GGUF',
  primaryFile: 'gemma-4-E4B-it-Q4_K_M.gguf',
  projectorFile: 'mmproj-gemma-4-E4B-it-F16.gguf',
  availableFiles: ['gemma-4-E4B-it-Q4_K_M.gguf', 'mmproj-gemma-4-E4B-it-F16.gguf']
}
const uiMateModel = {
  id: UI_MATE_GGUF_REPOSITORY,
  primaryFile: 'tencent_UI-Mate-9B-Q4_K_M.gguf',
  projectorFile: 'mmproj-tencent_UI-Mate-9B-f16.gguf',
  availableFiles: ['tencent_UI-Mate-9B-Q4_K_M.gguf', 'mmproj-tencent_UI-Mate-9B-f16.gguf']
}
const uiTarsModel = {
  id: 'mradermacher/UI-TARS-1.5-7B-GGUF',
  primaryFile: 'UI-TARS-1.5-7B-Q4_K_M.gguf',
  projectorFile: 'mmproj-UI-TARS-1.5-7B-f16.gguf',
  availableFiles: ['UI-TARS-1.5-7B-Q4_K_M.gguf', 'mmproj-UI-TARS-1.5-7B-f16.gguf']
}
const bounds = { width: 744, height: 1024 }

function verdict(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    direction: 'aligned',
    milestone_complete: false,
    action_verdict: 'approve',
    summary: 'The milestone still needs one result.',
    visible_evidence: 'The Roundtrip control is visible near the upper left.',
    action: "click(point='100 295')",
    action_reason: 'The point is visibly inside the Roundtrip control.',
    ...overrides
  })
}

describe('General vision operator adapter', () => {
  afterEach(() => vi.restoreAllMocks())

  it('selects Gemma and builds one strict thinking-enabled visual decision request', () => {
    const adapter = resolveVisionModelAdapter(gemmaModel)
    const request = adapter.buildRequest({
      goal: 'Find a one-way flight from SFO to PNQ.',
      currentMilestone: 'Enter the flight details.',
      currentScreenshotDataUrl: 'data:image/png;base64,current',
      coordinateFrame: { encoded: bounds, source: { width: 1064, height: 1464 } },
      history: [
        {
          response: verdict({ summary: 'The site is open.' }),
          actionText: 'Open the site'
        }
      ],
      recentSteps: ['Opened Skyscanner.'],
      olderVisualFacts: [],
      verifiedActions: ['Opened the site.']
    })

    expect(adapter.id).toBe('general-vision-operator')
    expect(request.enableThinking).toBe(true)
    expect(request.separateReasoning).toBe(true)
    expect(request.requireFinalAnswer).toBe(true)
    expect(request.responseFormat).toMatchObject({
      json_schema: { name: 'visual_step_decision', strict: true }
    })
    const serialized = JSON.stringify(request.messages)
    expect(serialized).toContain('Find a one-way flight from SFO to PNQ')
    expect(serialized).toContain('Enter the flight details')
    expect(serialized).toContain('Opened the site')
    expect(serialized).toContain('Prior validated judge decisions')
    expect(serialized).toContain('The site is open')
    expect(serialized).toContain('744 pixels wide and 1024 pixels high')
    expect(serialized).toContain('summary must directly report every concrete value requested')
    expect(serialized).not.toContain('1064 pixels wide')
  })

  it.each([
    ['UI-Mate', uiMateModel, 'ui-mate'],
    ['UI-TARS', uiTarsModel, 'ui-tars'],
    ['general vision', gemmaModel, 'general-vision-operator']
  ] as const)('selects the canonical strict contract for %s', (_label, model, expectedId) => {
    const adapter = resolveVisionModelAdapter(model)
    const request = adapter.buildRequest({
      goal: 'Use the visible control.',
      currentMilestone: 'Open the menu.',
      currentScreenshotDataUrl: 'data:image/png;base64,current',
      coordinateFrame: { encoded: bounds, source: bounds },
      history: [],
      recentSteps: ['The page is ready.'],
      olderVisualFacts: [],
      verifiedActions: []
    })

    expect(adapter.id).toBe(expectedId)
    expect(request).toMatchObject({
      enableThinking: true,
      separateReasoning: true,
      requireFinalAnswer: true,
      maxAttempts: 1,
      responseFormat: { json_schema: { name: 'visual_step_decision', strict: true } }
    })
    expect(request.disableThinking).not.toBe(true)
    expect(request.validateResponse?.(verdict())).toBe(true)
    expect(adapter.parseResponse(verdict(), bounds)).toMatchObject({
      kind: 'actions',
      actions: [{ type: 'click', point: { x: 100, y: 295 } }]
    })
  })

  it('uses only the final answer after separated thinking', () => {
    expect(answerAfterThinking('<think>private notes</think>\nfinal answer')).toBe('final answer')
    expect(answerAfterThinking('<think>unfinished private notes')).toBe('')
  })

  it('normalizes a fenced final answer without weakening its JSON schema', () => {
    expect(normalizedPolicyAnswer(`\`\`\`json\n${verdict()}\n\`\`\``)).toBe(verdict())
    expect(
      parseGeneralStepDecision(normalizedPolicyAnswer(`\`\`\`json\n${verdict()}\n\`\`\``), bounds)
    ).not.toBeNull()
  })

  it('includes the exact validation failure in the shared retry instruction', () => {
    const messages = [{ role: 'system' as const, content: 'policy' }]
    expect(visionPolicyMessagesForAttempt(messages, 1)).toBe(messages)
    expect(
      visionPolicyMessagesForAttempt(
        messages,
        2,
        '{"wrong":true}',
        'direction "complete" was not "aligned" or "off_course"'
      )
    ).toEqual([
      ...messages,
      { role: 'assistant', content: '{"wrong":true}' },
      expect.objectContaining({
        role: 'system',
        content: expect.stringContaining('direction "complete" was not "aligned" or "off_course"')
      })
    ])
  })

  it('reports a safe remote fetch cause instead of the generic fetch failure', () => {
    const error = new Error('fetch failed', {
      cause: Object.assign(new Error('the remote peer closed the connection'), {
        code: 'UND_ERR_SOCKET'
      })
    })
    expect(remoteVisionTransportError(error).message).toBe(
      'Remote model connection failed: the remote peer closed the connection (UND_ERR_SOCKET).'
    )
  })

  it('reports the actionable provider failure instead of a generic gateway message', () => {
    expect(
      remoteVisionProviderError(429, {
        error: {
          message: 'Provider returned error',
          metadata: {
            raw: 'The selected model is temporarily rate-limited upstream.',
            provider_name: 'Example provider'
          }
        }
      }).message
    ).toBe(
      'Remote model server returned HTTP 429 from Example provider: The selected model is temporarily rate-limited upstream.'
    )
  })

  it('keeps milestone completion independent and suppresses its proposed action', () => {
    const parsed = parseGeneralVisionOperatorResponse(
      verdict({ milestone_complete: true, action_verdict: 'none', action: null }),
      bounds
    )

    expect(parsed).toMatchObject({ kind: 'phase_complete' })
    expect(parsed).not.toHaveProperty('actions')
  })

  it('preserves approved coordinates in the exact encoded screenshot space', () => {
    const parsed = parseGeneralVisionOperatorResponse(verdict(), bounds)

    expect(parsed).toMatchObject({
      kind: 'actions',
      actions: [{ type: 'click', point: { x: 100, y: 295 } }]
    })
  })

  it('allows an approved corrective action while direction is off-course', () => {
    const parsed = parseGeneralVisionOperatorResponse(
      verdict({ direction: 'off_course', action_reason: 'This returns to the correct task path.' }),
      bounds
    )

    expect(parsed.kind).toBe('actions')
  })

  it.each(['aligned', 'off_course'] as const)(
    'turns a %s rethink verdict into a non-actuating decision',
    (direction) => {
      const parsed = parseGeneralVisionOperatorResponse(
        verdict({ direction, action_verdict: 'rethink', action: null }),
        bounds
      )

      expect(parsed).toMatchObject({ kind: 'rethink', direction })
    }
  )

  it('accepts a null action when no action should run', () => {
    expect(
      parseGeneralStepDecision(
        verdict({ milestone_complete: true, action_verdict: 'none', action: null }),
        bounds
      )
    ).toMatchObject({ milestoneComplete: true, actionVerdict: 'none', action: '' })
  })

  it.each(['none', 'null', 'subtask_complete()'])(
    'rejects the non-structured no-action literal %s',
    (action) => {
      expect(
        parseGeneralStepDecision(
          verdict({ milestone_complete: true, action_verdict: 'none', action }),
          bounds
        )
      ).toBeNull()
    }
  )

  it.each(['approve', 'rethink'] as const)(
    'rejects a completed milestone with an inconsistent %s verdict',
    (actionVerdict) => {
      expect(
        parseGeneralStepDecision(
          verdict({ milestone_complete: true, action_verdict: actionVerdict, action: null }),
          bounds
        )
      ).toBeNull()
    }
  )

  it('does not reject concise decision text because of an arbitrary character limit', () => {
    expect(
      parseGeneralStepDecision(
        verdict({
          summary: 's'.repeat(500),
          visible_evidence: 'e'.repeat(800),
          action_reason: 'r'.repeat(600)
        }),
        bounds
      )
    ).not.toBeNull()
  })

  it('rejects a null action when an action is approved', () => {
    expect(generalStepDecisionFailure(verdict({ action: null }), bounds)).toBe(
      'an approved verdict had no action'
    )
  })

  it('reports the rejected direction value', () => {
    expect(generalStepDecisionFailure(verdict({ direction: 'complete' }), bounds)).toBe(
      'direction "complete" was not "aligned" or "off_course"'
    )
  })

  it('rejects malformed or extra structured fields', () => {
    expect(parseGeneralStepDecision('{"direction":"aligned"}', bounds)).toBeNull()
    expect(parseGeneralStepDecision(verdict({ unexpected: true }), bounds)).toBeNull()
    expect(generalStepDecisionFailure('{"direction":"aligned"}', bounds)).toContain(
      'missing fields'
    )
    expect(generalStepDecisionFailure(verdict({ action: 'not_an_action' }), bounds)).toBe(
      'an approved verdict did not contain exactly one action'
    )
    expect(
      generalStepDecisionFailure(
        verdict({ action: "click(point='100 295'), click(point='200 300')" }),
        bounds
      )
    ).toBe('an approved verdict did not contain exactly one action')
    expect(
      generalStepDecisionFailure(verdict({ action: "click(point='100 295') trailing" }), bounds)
    ).toBe('an approved verdict did not contain exactly one action')
    expect(
      generalStepDecisionFailure(verdict({ action: ["click(point='100 295')"] }), bounds)
    ).toBe('action was not text or null')
  })

  it('accepts the strict decision fields in any JSON object order', () => {
    const shuffled = Object.fromEntries(Object.entries(JSON.parse(verdict())).reverse())

    expect(parseGeneralStepDecision(JSON.stringify(shuffled), bounds)).not.toBeNull()
  })

  it('does not misclassify action-like text inside a single type action', () => {
    expect(
      parseGeneralStepDecision(verdict({ action: "type(content='Then, click(save)')" }), bounds)
    ).not.toBeNull()
  })

  it('uses the same validation error for general and UI-TARS adapters', () => {
    expect(parseGeneralVisionOperatorResponse('not an action', bounds)).toMatchObject({
      kind: 'invalid',
      error: 'the final answer was not valid JSON'
    })
    expect(uiTarsAdapter.parseResponse('not an action', bounds)).toMatchObject({
      kind: 'invalid',
      error: 'the final answer was not valid JSON'
    })
  })

  it('calls the model once for the combined decision', async () => {
    const imagePath = path.join(os.tmpdir(), `offgrid-vision-${process.pid}.png`)
    fs.writeFileSync(imagePath, Buffer.from('89504e470d0a1a0a', 'hex'))
    const chat = vi.spyOn(llm, 'chatMessages').mockResolvedValue(verdict())

    try {
      const ground = createVisionGrounder(generalVisionOperatorAdapter)
      const result = await ground({
        goal: 'Open the trip type menu.',
        image: imagePath,
        history: [],
        retrievedFacts: [],
        policyHistory: [],
        guidance: [],
        coordinateFrame: { encoded: bounds, source: bounds }
      })

      expect(chat).toHaveBeenCalledTimes(1)
      expect(result.response).toBe(verdict())
      expect(result.modelInput).toContain('Visual step decision request')
    } finally {
      fs.rmSync(imagePath, { force: true })
    }
  })

  it('fails closed after malformed final answers exhaust retries', async () => {
    vi.spyOn(llm, 'chatMessages').mockResolvedValue('{"direction":"aligned"}')
    const request = generalVisionOperatorAdapter.buildRequest({
      goal: 'Open the control.',
      currentScreenshotDataUrl: 'data:image/png;base64,current',
      coordinateFrame: { encoded: bounds, source: bounds },
      history: [],
      recentSteps: [],
      olderVisualFacts: []
    })

    await expect(runVisionPolicyRequest(request)).rejects.toThrow('invalid final answer')
  })
})
