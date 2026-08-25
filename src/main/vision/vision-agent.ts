/**
 * The vision loop (R2-D): screenshot -> ground -> actuate, under the guard,
 * until the model reports finished, calls the user, or the guard stops it.
 * The supervised tier - every actuation is on the user's live desktop, so the
 * guard (kill switch, pause-on-input, step budget) gates each one and the user
 * always overrides.
 *
 * Every boundary is injected - the screen (capture + actuate), the grounding
 * model (ground), the guard, and the takeover wait - so the loop's control
 * flow is fully unit-tested without a display: what it actuates, what it
 * refuses, when it pauses, when it stops.
 */
import type { VisionAction, Bounds } from './vision-action'
import { parseVisionAction } from './vision-action'
import type { VisionGuard } from './vision-guard'
import {
  computerUseHistoryTokenBudget,
  tailWithinTokenBudget
} from '../../shared/computer-use-settings'
import type { ScreenshotGeometry } from './screenshot-geometry'

export interface VisionCaptureMetadata {
  path?: string
  geometry?: ScreenshotGeometry
}

export interface VisionActuationResult {
  mappedAction?: VisionAction
}

export interface VisionGroundingInput {
  goal: string
  image: string
  history: string[]
  retrievedFacts: string[]
}

export interface VisionStepObservation {
  step: number
  promptContext: string
  screenshot: { image: string; bounds: Bounds; metadata?: VisionCaptureMetadata }
  retrievedFacts: string[]
  rawResponse?: string
  parsedAction?: VisionAction | null
  mappedAction?: VisionAction
  durationMs: number
  result: 'parse_failed' | 'actuated' | 'terminal' | 'handoff' | 'blocked' | 'error'
  error?: string
}

export interface VisionScreen {
  /** The current screenshot reference and its encoded-image pixel bounds. */
  capture(): Promise<{ image: string; bounds: Bounds; metadata?: VisionCaptureMetadata }>
  /** Perform one grounded action on the live desktop. */
  actuate(action: VisionAction): Promise<VisionActuationResult | void>
}

export interface VisionTaskDeps {
  screen: VisionScreen
  guard: VisionGuard
  /** The grounding model: the goal + a screenshot in, one UI-TARS action out. */
  ground: (input: VisionGroundingInput) => Promise<string>
  /** Parks until the user finishes a call_user handoff. */
  waitForUser: (why: string) => Promise<void>
  onStep?: (note: string) => void
  onObservation?: (observation: VisionStepObservation) => void
  onCheckpoint?: (step: number, steps: readonly string[]) => void
  contextTokens?: number
  checkpointInterval?: number
  retrievedFacts?: string[]
  now?: () => number
}

export interface VisionTaskResult {
  ok: boolean
  summary: string
  steps: string[]
  handoffs: number
}

const DEFAULT_HISTORY_TOKENS = 2_048

export function buildGroundingHistory(
  steps: string[],
  tokenBudget = DEFAULT_HISTORY_TOKENS
): string[] {
  return tailWithinTokenBudget(steps, tokenBudget)
}

/* eslint-disable complexity -- one supervised state machine; per-verb helpers
   would hide the guard/pause/stop control flow the tests pin down. */
export async function runVisionTask(goal: string, deps: VisionTaskDeps): Promise<VisionTaskResult> {
  const { screen, guard, ground, waitForUser, onStep } = deps
  const steps: string[] = []
  let handoffs = 0
  let modelStep = 0
  const now = deps.now ?? Date.now
  const retrievedFacts = deps.retrievedFacts ?? []
  const checkpointInterval = Math.max(1, Math.floor(deps.checkpointInterval ?? 9))
  const note = (line: string): void => {
    steps.push(line)
    onStep?.(line)
  }
  const checkpoint = (): void => {
    if (modelStep % checkpointInterval === 0) {
      deps.onCheckpoint?.(modelStep, steps)
    }
  }

  for (;;) {
    if (!guard.canActuate()) {
      const { state, reason } = guard.snapshot()
      if (state === 'paused') {
        // The user took over. Wait for them, then re-observe from wherever
        // they left the screen.
        note(`paused: ${reason}`)
        await waitForUser(reason)
        guard.resume()
        note('resumed by the user')
        continue
      }
      note(`stopped: ${reason}`)
      return { ok: false, summary: reason, steps, handoffs }
    }

    modelStep += 1
    const startedAt = now()
    let shot: Awaited<ReturnType<VisionScreen['capture']>> | undefined
    let rawResponse: string
    const history = buildGroundingHistory(
      steps,
      computerUseHistoryTokenBudget(deps.contextTokens ?? DEFAULT_HISTORY_TOKENS)
    )
    const promptContext = [
      `Task: ${goal}`,
      retrievedFacts.length > 0 ? `Past task facts:\n${retrievedFacts.join('\n')}` : '',
      history.length > 0 ? `Current task history:\n${history.join('\n')}` : ''
    ]
      .filter(Boolean)
      .join('\n\n')
    try {
      shot = await screen.capture()
      rawResponse = await ground({ goal, image: shot.image, history, retrievedFacts })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'computer use step failed'
      deps.onObservation?.({
        step: modelStep,
        promptContext,
        screenshot: shot ?? { image: '', bounds: { width: 0, height: 0 } },
        retrievedFacts,
        durationMs: now() - startedAt,
        result: 'error',
        error: message
      })
      throw error
    }
    const action = parseVisionAction(rawResponse, shot.bounds)
    if (!action) {
      deps.onObservation?.({
        step: modelStep,
        promptContext,
        screenshot: shot,
        retrievedFacts,
        rawResponse,
        parsedAction: null,
        durationMs: now() - startedAt,
        result: 'parse_failed'
      })
      note('model action did not parse; re-observing')
      checkpoint()
      continue
    }
    if (action.type === 'finished') {
      deps.onObservation?.({
        step: modelStep,
        promptContext,
        screenshot: shot,
        retrievedFacts,
        rawResponse,
        parsedAction: action,
        durationMs: now() - startedAt,
        result: 'terminal'
      })
      note(`done: ${action.content}`)
      checkpoint()
      return { ok: true, summary: action.content || 'done', steps, handoffs }
    }
    if (action.type === 'call_user') {
      deps.onObservation?.({
        step: modelStep,
        promptContext,
        screenshot: shot,
        retrievedFacts,
        rawResponse,
        parsedAction: action,
        durationMs: now() - startedAt,
        result: 'handoff'
      })
      handoffs += 1
      note(`handoff: ${action.content}`)
      checkpoint()
      await waitForUser(action.content)
      note('resumed by the user')
      continue
    }
    // A real actuation: re-check the guard right before dispatch (the user may
    // have hit Esc since canActuate above), then count the step.
    if (!guard.canActuate()) {
      deps.onObservation?.({
        step: modelStep,
        promptContext,
        screenshot: shot,
        retrievedFacts,
        rawResponse,
        parsedAction: action,
        durationMs: now() - startedAt,
        result: 'blocked'
      })
      checkpoint()
      continue
    }
    let actuation: VisionActuationResult | void
    try {
      actuation = await screen.actuate(action)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'computer use action failed'
      deps.onObservation?.({
        step: modelStep,
        promptContext,
        screenshot: shot,
        retrievedFacts,
        rawResponse,
        parsedAction: action,
        durationMs: now() - startedAt,
        result: 'error',
        error: message
      })
      checkpoint()
      throw error
    }
    guard.countStep()
    note(describeAction(action))
    deps.onObservation?.({
      step: modelStep,
      promptContext,
      screenshot: shot,
      retrievedFacts,
      rawResponse,
      parsedAction: action,
      ...(actuation?.mappedAction ? { mappedAction: actuation.mappedAction } : {}),
      durationMs: now() - startedAt,
      result: 'actuated'
    })
    checkpoint()
  }
}
/* eslint-enable complexity */

function describeAction(action: VisionAction): string {
  switch (action.type) {
    case 'click':
    case 'double_click':
    case 'right_click':
      return `${action.type} at (${action.point.x}, ${action.point.y})`
    case 'drag':
      return `drag (${action.from.x}, ${action.from.y}) -> (${action.to.x}, ${action.to.y})`
    case 'type':
      return `type ${JSON.stringify(action.content.slice(0, 40))}`
    case 'hotkey':
      return `hotkey ${action.keys}`
    case 'scroll':
      return `scroll ${action.direction} at (${action.point.x}, ${action.point.y})`
    case 'wait':
      return 'wait'
    default:
      return action.type
  }
}
