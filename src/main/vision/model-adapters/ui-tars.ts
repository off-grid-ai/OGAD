import { buildVisionPrompt, VISION_SYSTEM_PROMPT } from '../vision-prompt'
import { parseVisionAction } from '../vision-action'
import type { VisionModelAdapter, VisionPolicyDecision } from './types'

/** The existing UI-TARS protocol remains a first-class, separate adapter. */
export const uiTarsAdapter: VisionModelAdapter = {
  id: 'ui-tars',
  matches: () => true,
  assertCapabilities(model) {
    if (!model.projectorFile || !model.availableFiles.includes(model.projectorFile)) {
      throw new Error('The active computer-use model has no installed vision projector.')
    }
  },
  buildRequest(input) {
    return {
      messages: [
        { role: 'system', content: VISION_SYSTEM_PROMPT },
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: buildVisionPrompt(input.goal, input.recentSteps, input.olderVisualFacts)
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
  parseResponse(response, bounds): VisionPolicyDecision {
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
}
