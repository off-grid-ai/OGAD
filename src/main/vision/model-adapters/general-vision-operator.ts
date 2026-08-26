import { GENERAL_STEP_SYSTEM_PROMPT } from './canonical-vision-contract'
import {
  GENERAL_VISION_TOOLS,
  generalVisionPolicyFailure,
  parseGeneralVisionToolResponse
} from './general-vision-tools'
import type {
  VisionModelAdapter,
  VisionPolicyDecision,
  VisionPolicyInput,
  VisionPolicyResponse
} from './types'

export { generalVisionPolicyFailure } from './general-vision-tools'

export function parseGeneralVisionOperatorResponse(
  response: VisionPolicyResponse,
  bounds: Parameters<VisionModelAdapter['parseResponse']>[1],
  coordinateFrame?: Parameters<VisionModelAdapter['parseResponse']>[2]
): VisionPolicyDecision {
  return parseGeneralVisionToolResponse(response, coordinateFrame?.encoded ?? bounds)
}

function browserControlContext(input: VisionPolicyInput): string {
  if (input.operatorEnvironment !== 'embedded_browser') return ''
  return [
    'Web Use control limits:',
    '- The screenshot contains the web page only. It has no native address bar or tab strip.',
    '- Use a structured hotkey action with keys ALT+LEFT for Browser Back and ALT+RIGHT for Browser Forward.',
    '- Use a structured hotkey action with keys CTRL+R only to reload the current page. The host maps the primary modifier for its platform.',
    '- Use a structured navigate action with an HTTPS URL to open a different website. Do not try to focus an address bar first.',
    '- Never use CTRL+L, CMD+L, CTRL+W, or CMD+W. Those browser-chrome controls do not exist in this action surface.',
    '- To leave an accidental detail or booking page, use Browser Back.'
  ].join('\n')
}

function previousActionContext(input: VisionPolicyInput): string {
  if (!input.previousClickMarker) return ''
  return `Previous action to judge:\n${input.verifiedActions?.at(-1) ?? 'click'}\nThe emerald-green marker at (${input.previousClickMarker.x}, ${input.previousClickMarker.y}) shows where that click landed in the current screenshot. Verify its visible result before choosing the next tool.`
}

function policyHistoryContext(input: VisionPolicyInput): string {
  if (!input.history.length) return ''
  return `Prior validated decisions:\n${input.history
    .slice(-12)
    .map((step) => step.response)
    .join('\n')}`
}

function taskContext(input: VisionPolicyInput): string {
  const encoded = input.coordinateFrame?.encoded
  return [
    `Task brief:\n${input.goal}`,
    browserControlContext(input),
    input.currentMilestone ? `Current milestone:\n${input.currentMilestone}` : '',
    input.verifiedActions?.length
      ? `Recent verified actions:\n${input.verifiedActions.slice(-12).join('\n')}`
      : 'Recent verified actions:\nNone yet.',
    previousActionContext(input),
    policyHistoryContext(input),
    input.recentSteps.length ? `Recent task events:\n${input.recentSteps.join('\n')}` : '',
    input.olderVisualFacts.length
      ? `Older task outcomes. These can be stale:\n${input.olderVisualFacts.join('\n')}`
      : '',
    encoded
      ? `Screenshot coordinate space:\nThe supplied screenshot is ${encoded.width} pixels wide and ${encoded.height} pixels high. Return every action point in the model's 0-1000 normalized coordinate space: x=0 is the left edge, x=1000 is the right edge, y=0 is the top edge, and y=1000 is the bottom edge.`
      : '',
    'Inspect the screenshot and call exactly one transition tool.'
  ]
    .filter(Boolean)
    .join('\n\n')
}

export function buildCanonicalVisionOperatorRequest(
  input: VisionPolicyInput
): ReturnType<VisionModelAdapter['buildRequest']> {
  const encoded = input.coordinateFrame?.encoded
  return {
    messages: [
      { role: 'system', content: GENERAL_STEP_SYSTEM_PROMPT },
      {
        role: 'user',
        content: [
          { type: 'text', text: taskContext(input) },
          { type: 'image_url', image_url: { url: input.currentScreenshotDataUrl } }
        ]
      }
    ],
    maxTokens: 1_200,
    timeoutMs: 90_000,
    maxAttempts: 2,
    tools: [...GENERAL_VISION_TOOLS],
    toolChoice: 'required',
    temperature: 0.1,
    topP: 0.9,
    enableThinking: true,
    separateReasoning: true,
    validateResponse: (response) =>
      encoded ? generalVisionPolicyFailure(response, encoded) === undefined : false,
    responseValidationError: (response) =>
      encoded ? generalVisionPolicyFailure(response, encoded) : 'screenshot bounds were missing'
  }
}

export const generalVisionOperatorAdapter: VisionModelAdapter = {
  id: 'general-vision-operator',
  matches(model) {
    return /(?:gemma[-_]?4|qwen3(?:[._-]?(?:5|8|vl))?)/i.test(`${model.id} ${model.primaryFile}`)
  },
  assertCapabilities(model) {
    if (!model.projectorFile || !model.availableFiles.includes(model.projectorFile)) {
      throw new Error('The active general vision model has no installed vision projector.')
    }
  },
  buildRequest: buildCanonicalVisionOperatorRequest,
  parseResponse() {
    return {
      kind: 'invalid',
      actionText: '',
      error: 'The general vision model did not return a native tool decision.'
    }
  },
  parsePolicyResponse: parseGeneralVisionOperatorResponse
}
