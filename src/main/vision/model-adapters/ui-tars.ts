import { VISION_SYSTEM_PROMPT } from '../vision-prompt'
import { parseVisionActionFromSourcePixels } from '../vision-action'
import type { VisionModelAdapter, VisionPolicyDecision } from './types'
import { formatContinuationCapsule } from './continuation-capsule'

const UI_TARS_ACTION_LINE = /^\s*(?:(?:action(?:\s+effect)?)\s*:\s*)?(?:click|left_single|left_double|double_click|right_single|right_click|drag|type|hotkey|scroll|navigate|wait|subtask_complete|finished|call_user)\s*\(/i

function uiTarsInstruction(input: Parameters<VisionModelAdapter['buildRequest']>[0]): string {
  const bounds = input.coordinateFrame?.encoded
  const groundingOnly = /^Locate one visible target\./i.test(input.goal)
  const activeInstruction = input.currentMilestone
    ? [
        `Only active instruction: ${input.currentMilestone}`,
        'If this result is already visible, return subtask_complete(). Do not perform an action for a later milestone.',
        `Full task context for reference only: ${input.goal}`
      ].join('\n')
    : input.goal
  return [
    groundingOnly
      ? [
          activeInstruction,
          'Grounding-only contract: return exactly one coordinate-bearing pointer action for the named target.',
          'Do not choose a different target or action verb. Do not type, press keys, scroll, wait, navigate, or report completion.'
        ].join('\n')
      : activeInstruction,
    bounds
      ? [
          'Coordinate frame:',
          `- The screenshot is exactly ${bounds.width} by ${bounds.height} pixels.`,
          `- Return screenshot pixel coordinates: x is 0-${bounds.width - 1}; y is 0-${bounds.height - 1}.`,
          '- Return the center of the visible target. Do not add offsets for browser or window chrome.'
        ].join('\n')
      : '',
    formatContinuationCapsule(input.continuation),
    input.recentSteps.length
      ? `Recent verified task events:\n${input.recentSteps.slice(-4).join('\n')}`
      : ''
  ]
    .filter(Boolean)
    .join('\n\n')
}

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
  const actionLines = response.split(/\r?\n/).filter((line) => UI_TARS_ACTION_LINE.test(line))
  if (actionLines.length > 1) {
    return {
      kind: 'invalid',
      actionText: '',
      error: 'UI-TARS returned more than one action for one observation.'
    }
  }
  const action = parseVisionActionFromSourcePixels(response, bounds, bounds)
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
    const bounds = input.coordinateFrame?.encoded
    const systemPrompt = bounds
      ? VISION_SYSTEM_PROMPT.replace(
          'Coordinates are 0-1000 normalized over the screenshot.',
          `Coordinates are screenshot pixels. This screenshot is ${bounds.width} by ${bounds.height} pixels; x is 0-${bounds.width - 1} and y is 0-${bounds.height - 1}.`
        )
      : VISION_SYSTEM_PROMPT
    return {
      messages: [
        { role: 'system', content: systemPrompt },
        {
          role: 'user',
          content: [
            { type: 'text', text: uiTarsInstruction(input) },
            { type: 'image_url', image_url: { url: input.currentScreenshotDataUrl } }
          ]
        }
      ],
      maxAttempts: 2,
      temperature: 0,
      disableThinking: true
    }
  },
  parseResponse: parseUiTarsPolicyResponse
}
