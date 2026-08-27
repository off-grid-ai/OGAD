import { buildVisionPrompt, VISION_SYSTEM_PROMPT } from '../vision-prompt'
import { parseVisionAction } from '../vision-action'
import type { VisionModelAdapter, VisionPolicyDecision } from './types'

/** UI-TARS remains on its native single action-text protocol. */
export function parseUiTarsPolicyResponse(
  response: string,
  bounds: Parameters<VisionModelAdapter['parseResponse']>[1]
): VisionPolicyDecision {
  if (/^\s*(?:Action:\s*)?subtask_complete\(\)\s*$/i.test(response)) {
    return {
      kind: 'phase_complete',
      actionText: 'Milestone complete',
      summary: 'The current milestone is visibly complete.'
    }
  }
  const action = parseVisionAction(response, bounds)
  if (!action) return { kind: 'invalid', actionText: '', error: 'UI-TARS action did not parse.' }
  if (action.type === 'finished') {
    return { kind: 'done', actionText: action.content, summary: action.content || 'done' }
  }
  if (action.type === 'call_user') {
    return { kind: 'handoff', actionText: action.content, reason: action.content }
  }
  if (action.type === 'wait') return { kind: 'wait', actionText: 'wait', durationMs: 0 }
  return { kind: 'actions', actionText: action.type, actions: [action] }
}

export const uiTarsAdapter: VisionModelAdapter = {
  id: 'ui-tars',
  /**
   * Only ACTUAL UI-TARS models. This used to be `() => true`, which - combined with being the
   * registry's fallback - meant every unrecognised model was driven with the UI-TARS prompt and
   * text DSL. Selecting Holo3.1-4B then failed to parse on every single step
   * ("UI-TARS action did not parse.; re-observing", 32 times, no progress), because Holo does not
   * emit that DSL. A specialist parser must claim only what it can actually parse.
   */
  matches(model) {
    return /ui[-_]?tars/i.test(`${model.id} ${model.primaryFile}`)
  },
  assertCapabilities(model) {
    if (!model.projectorFile || !model.availableFiles.includes(model.projectorFile)) {
      throw new Error('The active computer-use model has no installed vision projector.')
    }
  },
  buildRequest(input) {
    const objective = [
      input.goal,
      input.currentMilestone ? `Current milestone: ${input.currentMilestone}` : ''
    ]
      .filter(Boolean)
      .join('\n\n')
    return {
      messages: [
        { role: 'system', content: VISION_SYSTEM_PROMPT },
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: buildVisionPrompt(objective, input.recentSteps, input.olderVisualFacts)
            },
            { type: 'image_url', image_url: { url: input.currentScreenshotDataUrl } }
          ]
        }
      ],
      maxTokens: 200,
      timeoutMs: 60_000,
      maxAttempts: 1,
      disableThinking: true
    }
  },
  parseResponse: parseUiTarsPolicyResponse
}
