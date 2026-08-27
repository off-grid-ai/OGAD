import fs from 'node:fs'
import sharp from 'sharp'
import { COLORS_DARK, COLORS_LIGHT } from '@offgrid/design'
import { llm } from '../llm'
import { TASK_GUIDANCE_APPLIED_TRACE } from '../tasks/task-guide'
import type { VisionGroundingInput, VisionGroundingResult } from './vision-agent'
import type { VisionAction } from './vision-action'
import type {
  VisionModelAdapter,
  VisionPolicyInput,
  VisionPolicyMessage,
  VisionPolicyRequest,
  VisionPolicyResponse
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
  'Use the exact required decision contract. Do not rename, omit, or add fields or tool calls.'

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
): Promise<VisionPolicyResponse> {
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
      // Kept per attempt for two reasons: to tell a model that DECLINED to act (reasoned, called
      // nothing) from a genuinely empty response, and to hand its own reasoning back on the retry.
      let reasoningText = ''
      const useStream = Boolean(
        request.tools?.length || (onReasoningDelta && request.separateReasoning)
      )
      const rawResponse = useStream
        ? await llm.streamChat(
            messages,
            (text, kind) => {
              if (kind !== 'reasoning') return
              reasoningText += text
              onReasoningDelta?.(text)
            },
            {
              temperature: request.temperature,
              topP: request.topP,
              thinking: request.enableThinking === true && request.disableThinking !== true,
              responseFormat: request.responseFormat,
              tools: request.tools,
              toolChoice: request.toolChoice,
              maxTokens: request.maxTokens,
              signal
            },
            request.timeoutMs
          )
        : {
            content: await llm.chatMessages(messages, request.timeoutMs, request.maxTokens, {
              temperature: request.temperature,
              topP: request.topP,
              responseFormat: request.responseFormat,
              enableThinking: request.enableThinking,
              disableThinking: request.disableThinking,
              separateReasoning: request.separateReasoning,
              signal
            }),
            toolCalls: []
          }
      if (!rawResponse.content.trim() && rawResponse.toolCalls.length === 0) {
        // Reasoning but no action is the model DECLINING to act, not a dead connection - a real
        // run reasoned 1,249 tokens to a full stop ("...all the visible information about this
        // single flight option.") and then called nothing, on a page where it could not satisfy
        // the goal. tool_choice: 'required' is already sent; a provider is free to ignore it.
        //
        // The retry loop above can correct this, but only if it is TOLD to: with no prior answer
        // and no validation error recorded, attempt 2 re-sent a byte-identical request and failed
        // identically. Feeding the existing nudge seam is the fix - the mechanism was already
        // here, this path just never used it.
        // Hand the model its OWN reasoning back. It reached a conclusion in prose and then failed
        // only to express it as a tool call, so replaying that conclusion asks it to finish the
        // job rather than re-derive it from the screenshot with no memory of what it just decided.
        priorInvalidAnswer = reasoningText.trim() || undefined
        priorValidationError = reasoningText.trim()
          ? 'you reasoned to a conclusion but called no tool, so the decision was lost. Restate that same conclusion as exactly one tool call. Every outcome has a tool: complete_milestone when the phase is done, perform_action to act, rethink when the plan is wrong, call_user when the page cannot satisfy the goal. Answering with nothing is never correct'
          : 'the response was empty. Call exactly one tool'
        throw new Error(
          reasoningText.trim()
            ? 'Computer-use model reasoned but called no tool.'
            : 'Computer-use model returned no response.'
        )
      }
      const response: VisionPolicyResponse = {
        content: normalizedPolicyAnswer(rawResponse.content),
        toolCalls: rawResponse.toolCalls
      }
      const answer = response.content
      if (request.requireFinalAnswer && !answer) {
        throw new Error('Computer-use model returned reasoning without a final answer.')
      }
      if (request.validateResponse && !request.validateResponse(response)) {
        priorInvalidAnswer = serializeVisionPolicyResponse(response)
        const reason = request.responseValidationError?.(response)
        priorValidationError = reason
        console.warn(
          `[vision-policy] model decision rejected: ${reason || 'unknown validation error'}; response=${JSON.stringify(priorInvalidAnswer.slice(0, 4_000))}`
        )
        // Return the final malformed decision to the graph after the bounded
        // same-frame retry. The adapter supplies an invalid transition, and
        // LangGraph captures a fresh frame instead of ending the task.
        if (attempt === request.maxAttempts) return response
        throw new Error(
          `Computer-use model returned an invalid final answer${reason ? `: ${reason}` : ''}.`
        )
      }
      return response
    } catch (error) {
      if (signal?.aborted) throw error
      lastError = error
    }
  }
  throw lastError instanceof Error ? lastError : new Error('Computer-use model request failed.')
}

/** Stable audit/history form. Tool arguments are already model output; this
 * serialization never controls a transition. */
export function serializeVisionPolicyResponse(response: VisionPolicyResponse): string {
  if (response.toolCalls.length === 0) return response.content
  return JSON.stringify({
    ...(response.content ? { content: response.content } : {}),
    tool_calls: response.toolCalls
  })
}

interface PreviousClickMarker {
  x: number
  y: number
}

const COORDINATE_GRID_MAX = 1_000
const COORDINATE_GRID_INTERVAL = 20

/** Draw one stable 0-1000 reference grid without changing image dimensions.
 * The grid is evidence, so it is persisted with the exact model bytes. */
function normalizedCoordinateGrid(width: number, height: number): Buffer {
  const lineCount = COORDINATE_GRID_MAX / COORDINATE_GRID_INTERVAL + 1
  const verticalLines: string[] = []
  const xLabels: string[] = []
  const horizontalLines: string[] = []
  const yLabels: string[] = []
  for (let index = 0; index < lineCount; index += 1) {
    const value = index * COORDINATE_GRID_INTERVAL
    const x = Math.round((value * (width - 1)) / COORDINATE_GRID_MAX)
    verticalLines.push(`<line x1="${x}" y1="0" x2="${x}" y2="${height}"/>`)
    const labelX = Math.min(Math.max(3, x + 3), Math.max(3, width - 48))
    xLabels.push(`<text x="${labelX}" y="15">${value}</text>`)
    const y = Math.round((value * (height - 1)) / COORDINATE_GRID_MAX)
    horizontalLines.push(`<line x1="0" y1="${y}" x2="${width}" y2="${y}"/>`)
    const labelY = Math.min(Math.max(30, y + 14), Math.max(30, height - 4))
    yLabels.push(`<text x="3" y="${labelY}">${value}</text>`)
  }
  return Buffer.from(
    `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg"><g stroke="${COLORS_LIGHT.primary}" stroke-width="1" stroke-dasharray="4 6" opacity="0.22">${verticalLines.join('')}${horizontalLines.join('')}</g><g fill="${COLORS_LIGHT.primaryDark}" stroke="${COLORS_LIGHT.background}" stroke-width="2" paint-order="stroke" font-family="Menlo,monospace" font-size="11" font-weight="700" opacity="0.8">${xLabels.join('')}${yLabels.join('')}</g></svg>`
  )
}

/** The grid overlay is byte-identical for a given frame size, so rasterize it
 * once per (width, height) and reuse the PNG across every model step. */
const rasterizedGridCache = new Map<string, Promise<Buffer>>()

function rasterizedCoordinateGrid(width: number, height: number): Promise<Buffer> {
  const key = `${width}x${height}`
  let cached = rasterizedGridCache.get(key)
  if (!cached) {
    cached = sharp(normalizedCoordinateGrid(width, height)).png().toBuffer()
    cached.catch(() => rasterizedGridCache.delete(key))
    rasterizedGridCache.set(key, cached)
  }
  return cached
}

function clickPoint(action: VisionAction): { x: number; y: number } | undefined {
  switch (action.type) {
    case 'click':
    case 'double_click':
    case 'right_click':
    case 'middle_click':
    case 'triple_click':
      return action.point
    default:
      return undefined
  }
}

/** Project the prior click into the current encoded screenshot frame. */
export function previousClickMarker(input: VisionGroundingInput): PreviousClickMarker | undefined {
  const previous = input.previousVerifiedAction
  const currentFrame = input.coordinateFrame
  const point = previous ? clickPoint(previous.action) : undefined
  if (!previous || !currentFrame || !point) return undefined
  const previousBounds = previous.coordinateFrame.encoded
  const currentBounds = currentFrame.encoded
  if (
    previousBounds.width <= 0 ||
    previousBounds.height <= 0 ||
    currentBounds.width <= 0 ||
    currentBounds.height <= 0
  ) {
    return undefined
  }
  return {
    x: Math.max(
      0,
      Math.min(
        currentBounds.width - 1,
        Math.round((point.x * currentBounds.width) / previousBounds.width)
      )
    ),
    y: Math.max(
      0,
      Math.min(
        currentBounds.height - 1,
        Math.round((point.y * currentBounds.height) / previousBounds.height)
      )
    )
  }
}

/** Build the exact image used by the model and persist those same bytes at the
 * capture path used by task history. This keeps model evidence and the visible
 * task screenshot on one source of truth. */
export async function modelScreenshot(input: VisionGroundingInput): Promise<{
  dataUrl: string
  marker?: PreviousClickMarker
}> {
  const source = fs.readFileSync(input.image)
  const expected = input.coordinateFrame?.encoded
  if (!expected) {
    throw new Error('The visual model frame has no encoded dimensions.')
  }
  const metadata = await sharp(source).metadata()
  if (metadata.width !== expected.width || metadata.height !== expected.height) {
    throw new Error(
      `The visual model frame dimensions do not match: image is ${metadata.width}x${metadata.height}, coordinate frame is ${expected.width}x${expected.height}.`
    )
  }
  const marker = previousClickMarker(input)
  const overlays: Array<{ input: Buffer; left: number; top: number }> = [
    { input: await rasterizedCoordinateGrid(expected.width, expected.height), left: 0, top: 0 }
  ]
  if (marker) {
    const markerSize = Math.max(
      14,
      Math.min(24, Math.round(Math.min(expected.width, expected.height) * 0.025))
    )
    const radius = markerSize / 2
    overlays.push({
      input: Buffer.from(
        `<svg width="${markerSize}" height="${markerSize}" xmlns="http://www.w3.org/2000/svg"><circle cx="${radius}" cy="${radius}" r="${Math.max(2, radius - 2)}" fill="${COLORS_DARK.primary}" stroke="${COLORS_LIGHT.background}" stroke-width="2"/></svg>`
      ),
      left: Math.max(0, Math.min(expected.width - markerSize, Math.round(marker.x - radius))),
      top: Math.max(0, Math.min(expected.height - markerSize, Math.round(marker.y - radius)))
    })
  }
  const annotated = await sharp(source).composite(overlays).png().toBuffer()
  fs.writeFileSync(input.image, annotated)
  return { dataUrl: `data:image/png;base64,${annotated.toString('base64')}`, marker }
}

function visionPolicyInput(
  input: VisionGroundingInput,
  screenshotDataUrl: string,
  marker?: PreviousClickMarker,
  operatorEnvironment: VisionPolicyInput['operatorEnvironment'] = 'desktop'
): VisionPolicyInput {
  return {
    goal: input.goal,
    operatorEnvironment,
    currentScreenshotDataUrl: screenshotDataUrl,
    history: input.policyHistory,
    recentSteps: input.history,
    olderVisualFacts: input.retrievedFacts,
    currentMilestone: input.currentMilestone,
    verifiedActions: input.verifiedActions,
    previousClickMarker: marker,
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
  adapter: VisionModelAdapter,
  operatorEnvironment: VisionPolicyInput['operatorEnvironment'] = 'desktop'
): (input: VisionGroundingInput) => Promise<VisionGroundingResult> {
  return async (input) => {
    const screenshot = await modelScreenshot(input)
    const request = adapter.buildRequest(
      visionPolicyInput(input, screenshot.dataUrl, screenshot.marker, operatorEnvironment)
    )
    input.reportProgress?.('Reviewing direction, milestone, and next action')
    const policyResponse = await runVisionPolicyRequest(
      request,
      input.signal,
      input.reportReasoning
    )
    const response = serializeVisionPolicyResponse(policyResponse)
    const decision = adapter.parsePolicyResponse?.(
      policyResponse,
      input.coordinateFrame?.encoded ?? { width: 0, height: 0 },
      input.coordinateFrame
    )
    return {
      response,
      ...(decision ? { decision } : {}),
      modelInput: redactGuidance(
        `Visual step decision request:\n${serializeVisionPolicyMessages(request.messages)}`,
        input.guidance
      ),
      screenshotDataUrl: screenshot.dataUrl
    }
  }
}
