import { GENERAL_STEP_SYSTEM_PROMPT } from './canonical-vision-contract'
import { WEB_USE_CONTROL_INSTRUCTIONS } from '../../../shared/web-use-control'
import {
  GENERAL_VISION_TOOLS,
  generalVisionPolicyFailure,
  parseGeneralVisionToolResponse
} from './general-vision-tools'
import type { VisionModelAdapter, VisionPolicyInput } from './types'

export { generalVisionPolicyFailure } from './general-vision-tools'

function browserControlContext(input: VisionPolicyInput): string {
  if (input.operatorEnvironment !== 'embedded_browser') return ''
  return [
    'Web Use control limits:',
    ...WEB_USE_CONTROL_INSTRUCTIONS.map((instruction) => `- ${instruction}`)
  ].join('\n')
}

function desktopLaunchContext(input: VisionPolicyInput): string {
  if (input.operatorEnvironment !== 'desktop') return ''
  return 'Desktop launch: click an app only when its identity is visible; otherwise use the operating-system launcher or search.'
}

function previousActionContext(input: VisionPolicyInput): string {
  if (!input.previousClickMarker) return ''
  return `Previous click: ${input.verifiedActions?.at(-1) ?? 'click'}; marker at (${input.previousClickMarker.x}, ${input.previousClickMarker.y}). Verify its visible result.`
}

function taskContext(input: VisionPolicyInput): string {
  const encoded = input.coordinateFrame?.encoded
  const recentOutcomes = input.recentSteps
    .filter((step) => !step.startsWith('Execution plan:\n'))
    .slice(-4)
  return [
    `Task brief:\n${input.goal}`,
    browserControlContext(input),
    desktopLaunchContext(input),
    input.currentMilestone ? `Current milestone:\n${input.currentMilestone}` : '',
    previousActionContext(input),
    recentOutcomes.length ? `Recent outcomes:\n${recentOutcomes.join('\n')}` : '',
    input.olderVisualFacts.length
      ? `Past task facts:\n${input.olderVisualFacts.join('\n')}`
      : '',
    encoded
      ? `Screenshot: ${encoded.width} pixels wide and ${encoded.height} pixels high. Points use a 0-1000 coordinate frame.`
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
  /**
   * The DEFAULT operator, not a family. Any vision model with a projector can be driven by native
   * tool calling on the shared 0-1000 coordinate protocol, so listing names (gemma-4, qwen3.x) only
   * decided which models got sent down a text-DSL path they could not speak. Specialists above this
   * one in the registry claim their own models first; everything else belongs here.
   */
  matches: () => true,
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
  // The policy runner already passes the encoded coordinate frame as bounds.
  parsePolicyResponse: parseGeneralVisionToolResponse
}
