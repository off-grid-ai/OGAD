import fs from 'node:fs'
import sharp from 'sharp'
import { COLORS_DARK, COLORS_LIGHT } from '@offgrid/design'
import {
  runComputerUsePolicy,
  serializeComputerUsePolicyResponse,
  type ComputerUsePolicyGenerationPort
} from '@offgrid/models'
import { generateDesktopMessages } from '../desktop-generation'
import { TASK_GUIDANCE_APPLIED_TRACE } from '../tasks/task-guide'
import type { VisionGroundingInput, VisionGroundingResult } from './vision-agent'
import type { VisionAction } from './vision-action'
import type {
  VisionModelAdapter,
  VisionPolicyInput,
  VisionPolicyRequest,
  VisionPolicyResponse
} from './model-adapters/types'
import { serializeVisionPolicyMessages } from './model-adapters/model-input'

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
  return runComputerUsePolicy(request, desktopVisionGeneration, {
    signal,
    onReasoningDelta,
    onRejectedDecision({ reason, response }) {
      console.warn(
        `[vision-policy] model decision rejected: ${reason || 'unknown validation error'}; response=${JSON.stringify(response)}`
      )
    }
  })
}

const desktopVisionGeneration: ComputerUsePolicyGenerationPort = {
  async generate(input) {
    return generateDesktopMessages(
      input.messages.map((message) => ({
        role: message.role,
        content: Array.isArray(message.content)
          ? message.content.map((part) =>
              part.type === 'text'
                ? part
                : { type: 'image' as const, uri: part.image_url.url, detail: 'high' as const }
            )
          : message.content
      })),
      {
        ...input.profile,
        signal: input.signal,
        events: {
          chunk: (chunk) => {
            if (chunk.reasoning) input.onReasoningDelta?.(chunk.reasoning)
          }
        }
      }
    )
  }
}

/** Stable audit/history form. Tool arguments are already model output; this
 * serialization never controls a transition. */
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

export interface PreparedVisionGrounding {
  policyInput: VisionPolicyInput
  screenshotDataUrl: string
}

/** Annotate and persist the captured frame once. Multi-model strategies reuse
 * these exact bytes, so the reasoner, specialist, task history, and replay do
 * not diverge or draw the coordinate grid twice. */
export async function prepareVisionGrounding(
  input: VisionGroundingInput,
  operatorEnvironment: VisionPolicyInput['operatorEnvironment'] = 'desktop'
): Promise<PreparedVisionGrounding> {
  const screenshot = await modelScreenshot(input)
  return {
    policyInput: visionPolicyInput(
      input,
      screenshot.dataUrl,
      screenshot.marker,
      operatorEnvironment
    ),
    screenshotDataUrl: screenshot.dataUrl
  }
}

/** Run one adapter against an already-prepared frame. The adapter remains the
 * sole parser for its model protocol. */
export async function runPreparedVisionGrounder(
  adapter: VisionModelAdapter,
  input: VisionGroundingInput,
  prepared: PreparedVisionGrounding,
  policyInput: VisionPolicyInput = prepared.policyInput
): Promise<VisionGroundingResult> {
  const request = adapter.buildRequest(policyInput)
  request.generationRouteId = policyInput.generationRouteId
  input.reportProgress?.('Reviewing direction, milestone, and next action')
  const policyResponse = await runVisionPolicyRequest(request, input.signal, input.reportReasoning)
  const response = serializeComputerUsePolicyResponse(policyResponse)
  const bounds = input.coordinateFrame?.encoded ?? { width: 0, height: 0 }
  const decision = adapter.parsePolicyResponse
    ? adapter.parsePolicyResponse(policyResponse, bounds, input.coordinateFrame)
    : adapter.parseResponse(response, bounds, input.coordinateFrame)
  return {
    response,
    decision,
    modelInput: redactGuidance(
      `Visual step decision request:\n${serializeVisionPolicyMessages(request.messages)}`,
      input.guidance
    ),
    screenshotDataUrl: prepared.screenshotDataUrl
  }
}

/** One model call per screenshot. General adapters consolidate direction,
 * milestone completion, action choice, and action validation in this request;
 * specialist adapters keep their native one-call protocol. */
export function createVisionGrounder(
  adapter: VisionModelAdapter,
  operatorEnvironment: VisionPolicyInput['operatorEnvironment'] = 'desktop',
  routeId?: string
): (input: VisionGroundingInput) => Promise<VisionGroundingResult> {
  return async (input) => {
    const prepared = await prepareVisionGrounding(input, operatorEnvironment)
    return runPreparedVisionGrounder(adapter, input, prepared, {
      ...prepared.policyInput,
      generationRouteId: routeId
    })
  }
}
