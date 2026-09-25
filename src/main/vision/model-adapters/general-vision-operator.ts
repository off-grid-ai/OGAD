import { GENERAL_STEP_SYSTEM_PROMPT } from './canonical-vision-contract'
import { WEB_USE_CONTROL_INSTRUCTIONS } from '../../../shared/web-use-control'
import {
  BONSAI_VISION_TOOLS,
  GENERAL_VISION_TOOLS,
  generalVisionPolicyFailure,
  parseGeneralVisionToolResponse
} from './general-vision-tools'
import { formatContinuationCapsule } from './continuation-capsule'
import type {
  VisionModelAdapter,
  VisionPolicyHistoryStep,
  VisionPolicyInput,
  VisionPolicyMessage
} from './types'

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

function verificationContext(input: VisionPolicyInput): string {
  if (!input.previousExpectedEffect) return ''
  return [
    `Previous expected state: ${input.previousExpectedEffect}`,
    `Mechanical observation: ${input.previousActionEffect ?? 'unverifiable'}.`,
    'Use this fresh screenshot to decide whether the expected state is visibly satisfied. A different or unrelated screen change is inconclusive and must not prove success.'
  ].join('\n')
}

const TRAJECTORY_STEP_LIMIT = 12
const TRAJECTORY_CHAR_LIMIT = 24_000

function boundedTrajectory(history: readonly VisionPolicyHistoryStep[]): VisionPolicyHistoryStep[] {
  const retained: VisionPolicyHistoryStep[] = []
  let chars = 0
  for (const step of history.slice(-TRAJECTORY_STEP_LIMIT).reverse()) {
    const stepChars =
      step.response.length +
      step.actionText.length +
      (step.reasoning?.length ?? 0) +
      (step.result?.length ?? 0)
    if (retained.length > 0 && chars + stepChars > TRAJECTORY_CHAR_LIMIT) break
    retained.push(step)
    chars += stepChars
  }
  return retained.reverse()
}

function trajectoryMessages(history: readonly VisionPolicyHistoryStep[]): VisionPolicyMessage[] {
  return boundedTrajectory(history).flatMap((step, index) => {
    const observation: VisionPolicyMessage = {
      role: 'user',
      content: step.screenshotDataUrl
        ? [
            { type: 'text', text: `Ordered trajectory step ${index + 1} observation.` },
            { type: 'image_url', image_url: { url: step.screenshotDataUrl } }
          ]
        : `Ordered trajectory step ${index + 1} observation. The image is outside the bounded visual window.`
    }
    const assistant: VisionPolicyMessage = {
      role: 'assistant',
      content: `${step.reasoning ? `<think>${step.reasoning}</think>\n` : ''}${step.response}`
    }
    const result: VisionPolicyMessage = {
      role: 'user',
      content: `Tool result: ${step.result ?? `action crossed the execution boundary: ${step.actionText}`}`
    }
    return [observation, assistant, result]
  })
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
    formatContinuationCapsule(input.continuation),
    `Keep continuation.done to at most ${Math.max(0, input.continuationCapacity ?? 0)} recent confirmed outcomes. Replace the capsule; do not append a transcript.`,
    previousActionContext(input),
    verificationContext(input),
    recentOutcomes.length ? `Recent outcomes:\n${recentOutcomes.join('\n')}` : '',
    input.olderVisualFacts.length ? `Past task facts:\n${input.olderVisualFacts.join('\n')}` : '',
    encoded
      ? `Screenshot: ${encoded.width} pixels wide and ${encoded.height} pixels high. Points use a 0-1000 coordinate frame.`
      : '',
    'Inspect the screenshot and call exactly one transition tool.'
  ]
    .filter(Boolean)
    .join('\n\n')
}

function buildVisionOperatorRequest(
  input: VisionPolicyInput,
  profile: 'general' | 'bonsai'
): ReturnType<VisionModelAdapter['buildRequest']> {
  const encoded = input.coordinateFrame?.encoded
  return {
    messages: [
      { role: 'system', content: GENERAL_STEP_SYSTEM_PROMPT },
      ...trajectoryMessages(input.history),
      {
        role: 'user',
        content: [
          { type: 'text', text: taskContext(input) },
          { type: 'image_url', image_url: { url: input.currentScreenshotDataUrl } }
        ]
      }
    ],
    maxAttempts: 2,
    tools: [...(profile === 'bonsai' ? BONSAI_VISION_TOOLS : GENERAL_VISION_TOOLS)],
    toolChoice: 'required',
    temperature: profile === 'bonsai' ? 1 : 0.1,
    topP: profile === 'bonsai' ? 0.95 : 0.9,
    ...(profile === 'bonsai' ? { topK: 20, minP: 0, presencePenalty: 0, repeatPenalty: 1 } : {}),
    ...(profile === 'bonsai' ? { preserveThinking: true } : {}),
    enableThinking: true,
    separateReasoning: true,
    validateResponse: (response) =>
      encoded ? generalVisionPolicyFailure(response, encoded) === undefined : false,
    responseValidationError: (response) =>
      encoded ? generalVisionPolicyFailure(response, encoded) : 'screenshot bounds were missing'
  }
}

export function buildCanonicalVisionOperatorRequest(
  input: VisionPolicyInput
): ReturnType<VisionModelAdapter['buildRequest']> {
  return buildVisionOperatorRequest(input, 'general')
}

export function isBonsaiQwenVisionModel(model: { id: string; primaryFile: string }): boolean {
  return /(?:^|[/_-])(?:(?:ternary-)?bonsai-2-27b|qwen3[._-]?8)(?:[/_.-]|$)/i.test(
    `${model.id}/${model.primaryFile}`
  )
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

/** Qwen3.8-derived Bonsai profile. It keeps the general direct-operator protocol,
 * but applies the model's documented thinking sampler and expected-state contract. */
export const bonsaiVisionOperatorAdapter: VisionModelAdapter = {
  ...generalVisionOperatorAdapter,
  id: 'bonsai-qwen-direct-operator',
  matches: isBonsaiQwenVisionModel,
  buildRequest: (input) => buildVisionOperatorRequest(input, 'bonsai')
}
