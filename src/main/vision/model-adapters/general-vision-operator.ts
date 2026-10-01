import { GENERAL_STEP_SYSTEM_PROMPT } from './canonical-vision-contract'
import { WEB_USE_CONTROL_INSTRUCTIONS } from '../../../shared/web-use-control'
import {
  GENERAL_VISION_TOOLS,
  generalVisionPolicyFailure,
  parseGeneralVisionToolResponse
} from './general-vision-tools'
import { formatContinuationCapsule } from './continuation-capsule'
import type { VisionModelAdapter, VisionPolicyInput, VisionPolicyMessage } from './types'

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
    formatContinuationCapsule(input.continuation),
    `Keep continuation.done to at most ${Math.max(0, input.continuationCapacity ?? 0)} recent confirmed outcomes. Replace the capsule; do not append a transcript.`,
    previousActionContext(input),
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

const MAX_TRAJECTORY_STEPS = 12
const MAX_TRAJECTORY_TEXT_CHARS = 24_000

function boundedTrajectory(input: VisionPolicyInput): VisionPolicyInput['history'] {
  const bounded: VisionPolicyInput['history'][number][] = []
  let chars = 0
  for (const step of input.history.slice(-MAX_TRAJECTORY_STEPS).reverse()) {
    const stepChars =
      step.response.length +
      step.actionText.length +
      (step.reasoningContent?.length ?? 0) +
      (step.result?.length ?? 0)
    if (bounded.length > 0 && chars + stepChars > MAX_TRAJECTORY_TEXT_CHARS) break
    bounded.unshift(step)
    chars += stepChars
  }
  return bounded
}

function trajectoryMessages(
  input: VisionPolicyInput,
  preserveReasoning: boolean
): VisionPolicyMessage[] {
  return boundedTrajectory(input).flatMap((step, index) => {
    const observation = step.screenshotDataUrl
      ? {
          role: 'user' as const,
          content: [
            { type: 'text' as const, text: `Prior observation ${index + 1}.` },
            { type: 'image_url' as const, image_url: { url: step.screenshotDataUrl } }
          ]
        }
      : { role: 'user' as const, content: `Prior observation ${index + 1} (image omitted).` }
    return [
      observation,
      {
        role: 'assistant' as const,
        content: step.response,
        ...(preserveReasoning && step.reasoningContent
          ? { reasoning_content: step.reasoningContent }
          : {})
      },
      {
        role: 'user' as const,
        content: `Transition result: ${step.result ?? step.actionText}`
      }
    ]
  })
}

interface GeneralOperatorProfile {
  id: string
  preserveReasoning: boolean
  sampling: {
    temperature: number
    topP: number
    topK?: number
    minP?: number
    presencePenalty?: number
    repetitionPenalty?: number
  }
}

const GENERAL_PROFILE: GeneralOperatorProfile = {
  id: 'general-vision-operator',
  preserveReasoning: false,
  sampling: { temperature: 0.1, topP: 0.9 }
}

const BONSAI_QWEN_PROFILE: GeneralOperatorProfile = {
  id: 'bonsai-qwen-vision-operator',
  preserveReasoning: true,
  sampling: {
    temperature: 1,
    topP: 0.95,
    topK: 20,
    minP: 0,
    presencePenalty: 0,
    repetitionPenalty: 1
  }
}

export function buildCanonicalVisionOperatorRequest(
  input: VisionPolicyInput,
  profile: GeneralOperatorProfile = GENERAL_PROFILE
): ReturnType<VisionModelAdapter['buildRequest']> {
  const encoded = input.coordinateFrame?.encoded
  return {
    messages: [
      { role: 'system', content: GENERAL_STEP_SYSTEM_PROMPT },
      ...trajectoryMessages(input, profile.preserveReasoning),
      {
        role: 'user',
        content: [
          { type: 'text', text: taskContext(input) },
          { type: 'image_url', image_url: { url: input.currentScreenshotDataUrl } }
        ]
      }
    ],
    maxAttempts: 2,
    tools: [...GENERAL_VISION_TOOLS],
    toolChoice: 'required',
    ...profile.sampling,
    enableThinking: true,
    separateReasoning: true,
    validateResponse: (response) =>
      encoded ? generalVisionPolicyFailure(response, encoded) === undefined : false,
    responseValidationError: (response) =>
      encoded ? generalVisionPolicyFailure(response, encoded) : 'screenshot bounds were missing'
  }
}

function operatorAdapter(
  profile: GeneralOperatorProfile,
  matches: VisionModelAdapter['matches']
): VisionModelAdapter {
  return {
    id: profile.id,
    matches,
    assertCapabilities(model) {
      if (!model.projectorFile || !model.availableFiles.includes(model.projectorFile)) {
        throw new Error('The active general vision model has no installed vision projector.')
      }
    },
    buildRequest: (input) => buildCanonicalVisionOperatorRequest(input, profile),
    parseResponse() {
      return {
        kind: 'invalid',
        actionText: '',
        error: 'The general vision model did not return a native tool decision.'
      }
    },
    parsePolicyResponse: parseGeneralVisionToolResponse
  }
}

export const bonsaiQwenVisionOperatorAdapter = operatorAdapter(
  BONSAI_QWEN_PROFILE,
  (model) => /(?:bonsai[-_ ]?2|qwen3[._-]?8)/i.test(`${model.id} ${model.primaryFile}`)
)

export const generalVisionOperatorAdapter: VisionModelAdapter = {
  ...operatorAdapter(GENERAL_PROFILE, () => true),
  /**
   * The DEFAULT operator, not a family. Any vision model with a projector can be driven by native
   * tool calling on the shared 0-1000 coordinate protocol, so listing names (gemma-4, qwen3.x) only
   * decided which models got sent down a text-DSL path they could not speak. Specialists above this
   * one in the registry claim their own models first; everything else belongs here.
   */
}
