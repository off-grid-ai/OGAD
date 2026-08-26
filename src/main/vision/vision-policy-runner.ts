import fs from 'node:fs'
import { llm } from '../llm'
import { imageMime } from '../llm/chat-payload'
import { TASK_GUIDANCE_APPLIED_TRACE } from '../tasks/task-guide'
import type { VisionGroundingInput, VisionGroundingResult } from './vision-agent'
import type {
  VisionModelAdapter,
  VisionPolicyMessage,
  VisionPolicyRequest
} from './model-adapters/types'
import { serializeVisionPolicyMessages } from './model-adapters/model-input'

/** Return the answer after private reasoning. Policy decisions must never be
 * inferred from an unfinished reasoning channel. */
export function answerAfterThinking(response: string): string {
  const withoutClosedThinking = response.replace(/<think\b[^>]*>[\s\S]*?<\/think>/gi, '')
  if (/<think\b[^>]*>/i.test(withoutClosedThinking)) return ''
  return withoutClosedThinking.trim()
}

/** Normalize presentation wrappers without weakening the adapter schema. The
 * same final-answer boundary is used for local and remote models. */
export function normalizedPolicyAnswer(response: string): string {
  const answer = answerAfterThinking(response)
  const fenced = answer.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)
  return (fenced?.[1] ?? answer).trim()
}

const MALFORMED_POLICY_RETRY =
  'Return only the exact required JSON keys and value types. Do not rename, omit, or add fields.'

/** One retry policy for every vision transport. */
export function visionPolicyMessagesForAttempt(
  messages: VisionPolicyMessage[],
  attempt: number,
  priorInvalidAnswer?: string,
  priorValidationError?: string
): VisionPolicyMessage[] {
  if (attempt === 1) return messages
  return [
    ...messages,
    ...(priorInvalidAnswer
      ? [{ role: 'assistant' as const, content: priorInvalidAnswer.slice(0, 4_000) }]
      : []),
    {
      role: 'system',
      content: [
        priorValidationError
          ? `The prior final answer failed validation: ${priorValidationError}.`
          : 'The prior final answer failed validation.',
        MALFORMED_POLICY_RETRY
      ].join(' ')
    }
  ]
}

/** Keep remote transport errors useful without exposing endpoints, headers, or
 * request contents. Node's fetch puts the real network reason on `cause`. */
export function remoteVisionTransportError(error: unknown): Error {
  if (!(error instanceof Error)) return new Error('Remote model request failed.')
  const cause = error.cause
  if (!cause || typeof cause !== 'object') return error
  const detail = cause as { message?: unknown; code?: unknown }
  const message = typeof detail.message === 'string' ? detail.message.trim() : ''
  const code = typeof detail.code === 'string' ? detail.code.trim() : ''
  if (!message && !code) return error
  return new Error(
    `Remote model connection failed: ${message || 'network error'}${code ? ` (${code})` : ''}.`
  )
}

interface RemoteVisionResponseBody {
  error?: {
    message?: string
    code?: string | number
    metadata?: { raw?: string; provider_name?: string }
  }
  choices?: { message?: { content?: string } }[]
}

/** Preserve the provider's useful, non-secret failure reason. Some gateways use
 * a generic top-level message and put the actionable cause in metadata.raw. */
export function remoteVisionProviderError(status: number, body: RemoteVisionResponseBody): Error {
  const detail = body.error?.metadata?.raw?.trim() || body.error?.message?.trim()
  const provider = body.error?.metadata?.provider_name?.trim()
  return new Error(
    `Remote model server returned HTTP ${status}${provider ? ` from ${provider}` : ''}${detail ? `: ${detail}` : '.'}`
  )
}

export async function runVisionPolicyRequest(
  request: VisionPolicyRequest,
  signal?: AbortSignal,
  onReasoningDelta?: (text: string) => void
): Promise<string> {
  let lastError: unknown
  let priorInvalidAnswer: string | undefined
  let priorValidationError: string | undefined
  for (let attempt = 1; attempt <= request.maxAttempts; attempt += 1) {
    signal?.throwIfAborted()
    try {
      const messages = visionPolicyMessagesForAttempt(
        request.messages,
        attempt,
        priorInvalidAnswer,
        priorValidationError
      )
      const response =
        onReasoningDelta && request.separateReasoning
          ? (
              await llm.streamChat(
                messages,
                (text, kind) => {
                  if (kind === 'reasoning') onReasoningDelta(text)
                },
                {
                  temperature: request.temperature,
                  topP: request.topP,
                  thinking: request.enableThinking === true && request.disableThinking !== true,
                  responseFormat: request.responseFormat,
                  maxTokens: request.maxTokens,
                  signal
                },
                request.timeoutMs
              )
            ).content
          : await llm.chatMessages(messages, request.timeoutMs, request.maxTokens, {
              temperature: request.temperature,
              topP: request.topP,
              responseFormat: request.responseFormat,
              enableThinking: request.enableThinking,
              disableThinking: request.disableThinking,
              separateReasoning: request.separateReasoning,
              signal
            })
      if (!response.trim()) {
        throw new Error('Computer-use model returned no response.')
      }
      const answer = normalizedPolicyAnswer(response)
      if (request.requireFinalAnswer && !answer) {
        throw new Error('Computer-use model returned reasoning without a final answer.')
      }
      if (request.validateResponse && !request.validateResponse(answer)) {
        priorInvalidAnswer = answer
        const reason = request.responseValidationError?.(answer)
        priorValidationError = reason
        console.warn(
          `[vision-policy] local final answer rejected: ${reason || 'unknown validation error'}; answer=${JSON.stringify(answer.slice(0, 4_000))}`
        )
        throw new Error(
          `Computer-use model returned an invalid final answer${reason ? `: ${reason}` : ''}.`
        )
      }
      return answer
    } catch (error) {
      if (signal?.aborted) throw error
      lastError = error
    }
  }
  throw lastError instanceof Error ? lastError : new Error('Computer-use model request failed.')
}

function visionPolicyInput(input: VisionGroundingInput, screenshotDataUrl: string) {
  return {
    goal: input.goal,
    currentScreenshotDataUrl: screenshotDataUrl,
    history: input.policyHistory,
    recentSteps: input.history,
    olderVisualFacts: input.retrievedFacts,
    currentMilestone: input.currentMilestone,
    verifiedActions: input.verifiedActions,
    coordinateFrame: input.coordinateFrame
  }
}

function redactGuidance(serializedInput: string, guidance: readonly string[]): string {
  return guidance.reduce(
    (safeInput, privateText) => safeInput.split(privateText).join(TASK_GUIDANCE_APPLIED_TRACE),
    serializedInput
  )
}

/** One model call per screenshot. General adapters consolidate direction,
 * milestone completion, action choice, and action validation in this request;
 * specialist adapters keep their native one-call protocol. */
export function createVisionGrounder(
  adapter: VisionModelAdapter
): (input: VisionGroundingInput) => Promise<VisionGroundingResult> {
  return async (input) => {
    const screenshotDataUrl = `data:${imageMime(input.image)};base64,${fs.readFileSync(input.image).toString('base64')}`
    const request = adapter.buildRequest(visionPolicyInput(input, screenshotDataUrl))
    input.reportProgress?.('Reviewing direction, milestone, and next action')
    const response = await runVisionPolicyRequest(request, input.signal, input.reportReasoning)
    return {
      response,
      modelInput: redactGuidance(
        `Visual step decision request:\n${serializeVisionPolicyMessages(request.messages)}`,
        input.guidance
      ),
      screenshotDataUrl
    }
  }
}
