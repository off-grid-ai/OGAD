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
import type { VisionGuard } from './vision-guard'
import {
  computerUseHistoryTokenBudget,
  tailWithinTokenBudget
} from '../../shared/computer-use-settings'
import type { ScreenshotGeometry } from './screenshot-geometry'
import { uiTarsAdapter } from './model-adapters/ui-tars'
import type { VisionPolicyDecision, VisionPolicyHistoryStep } from './model-adapters/types'

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
  policyHistory: readonly VisionPolicyHistoryStep[]
}

export interface VisionGroundingResult {
  response: string
  /** Exact adapter messages with binary image payloads replaced by a marker. */
  modelInput: string
}

export interface VisionStepObservation {
  step: number
  promptContext: string
  screenshot: { image: string; bounds: Bounds; metadata?: VisionCaptureMetadata }
  retrievedFacts: string[]
  rawResponse?: string
  parsedAction?: VisionAction | null
  parsedActions?: readonly VisionAction[]
  failedActionIndex?: number
  mappedAction?: VisionAction
  mappedActions?: readonly VisionAction[]
  durationMs: number
  result: 'parse_failed' | 'actuated' | 'wait' | 'terminal' | 'handoff' | 'blocked' | 'error'
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
  ground: (input: VisionGroundingInput) => Promise<string | VisionGroundingResult>
  /** Model-family parser. Defaults to the legacy UI-TARS adapter. */
  parseResponse?: (response: string, bounds: Bounds) => VisionPolicyDecision
  /** Parks until the user finishes a call_user handoff. */
  waitForUser: (why: string) => Promise<void>
  onStep?: (note: string) => void
  onObservation?: (observation: VisionStepObservation) => void
  onCheckpoint?: (step: number, steps: readonly string[]) => void
  contextTokens?: number
  checkpointInterval?: number
  retrievedFacts?: string[]
  now?: () => number
  maxPlanningSteps?: number
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
  const policyHistory: VisionPolicyHistoryStep[] = []
  const parseResponse = deps.parseResponse ?? uiTarsAdapter.parseResponse
  const checkpointInterval = Math.max(1, Math.floor(deps.checkpointInterval ?? 9))
  const maxPlanningSteps = Math.max(1, Math.floor(deps.maxPlanningSteps ?? 100))
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
    if (modelStep >= maxPlanningSteps) {
      const summary = `Computer use stopped after ${maxPlanningSteps} planning steps.`
      note(summary)
      return { ok: false, summary, steps, handoffs }
    }
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
    let promptContext = [
      `Task: ${goal}`,
      retrievedFacts.length > 0 ? `Past task facts:\n${retrievedFacts.join('\n')}` : '',
      history.length > 0 ? `Current task history:\n${history.join('\n')}` : ''
    ]
      .filter(Boolean)
      .join('\n\n')
    try {
      shot = await screen.capture()
      const grounding = await ground({
        goal,
        image: shot.image,
        history,
        retrievedFacts,
        policyHistory
      })
      rawResponse = typeof grounding === 'string' ? grounding : grounding.response
      if (typeof grounding !== 'string') promptContext = grounding.modelInput
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
    const decision = parseResponse(rawResponse, shot.bounds)
    policyHistory.push({ response: rawResponse, actionText: decision.actionText })
    if (decision.kind === 'invalid') {
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
      note(`${decision.error}; re-observing`)
      checkpoint()
      continue
    }
    if (decision.kind === 'wait') {
      await new Promise((resolve) => setTimeout(resolve, decision.durationMs))
      deps.onObservation?.({
        step: modelStep,
        promptContext,
        screenshot: shot,
        retrievedFacts,
        rawResponse,
        durationMs: now() - startedAt,
        result: 'wait'
      })
      note(`wait ${decision.durationMs}ms`)
      checkpoint()
      continue
    }
    if (decision.kind === 'done' || decision.kind === 'failed') {
      deps.onObservation?.({
        step: modelStep,
        promptContext,
        screenshot: shot,
        retrievedFacts,
        rawResponse,
        durationMs: now() - startedAt,
        result: 'terminal'
      })
      note(`${decision.kind === 'done' ? 'done' : 'failed'}: ${decision.summary}`)
      checkpoint()
      return {
        ok: decision.kind === 'done',
        summary: decision.summary,
        steps,
        handoffs
      }
    }
    if (decision.kind === 'handoff') {
      deps.onObservation?.({
        step: modelStep,
        promptContext,
        screenshot: shot,
        retrievedFacts,
        rawResponse,
        durationMs: now() - startedAt,
        result: 'handoff'
      })
      handoffs += 1
      note(`handoff: ${decision.reason}`)
      checkpoint()
      await waitForUser(decision.reason)
      note('resumed by the user')
      continue
    }
    const mappedActions: VisionAction[] = []
    let actionIndex = 0
    let blocked = false
    try {
      for (const [index, action] of decision.actions.entries()) {
        actionIndex = index
        // Re-check before EVERY action in a multi-action model response.
        if (!guard.canActuate()) {
          blocked = true
          break
        }
        const actuation = await screen.actuate(action)
        guard.countStep()
        note(describeAction(action))
        if (actuation?.mappedAction) mappedActions.push(actuation.mappedAction)
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'computer use action failed'
      deps.onObservation?.({
        step: modelStep,
        promptContext,
        screenshot: shot,
        retrievedFacts,
        rawResponse,
        parsedAction: decision.actions[actionIndex],
        parsedActions: decision.actions,
        failedActionIndex: actionIndex,
        ...(mappedActions[0] ? { mappedAction: mappedActions[0] } : {}),
        ...(mappedActions.length > 0 ? { mappedActions } : {}),
        durationMs: now() - startedAt,
        result: 'error',
        error: message
      })
      checkpoint()
      throw error
    }
    deps.onObservation?.({
      step: modelStep,
      promptContext,
      screenshot: shot,
      retrievedFacts,
      rawResponse,
      parsedAction: decision.actions[0],
      parsedActions: decision.actions,
      ...(mappedActions[0] ? { mappedAction: mappedActions[0] } : {}),
      ...(mappedActions.length > 0 ? { mappedActions } : {}),
      durationMs: now() - startedAt,
      result: blocked ? 'blocked' : 'actuated'
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
    case 'middle_click':
    case 'triple_click':
      return `${action.type} at (${action.point.x}, ${action.point.y})`
    case 'drag':
      return `drag (${action.from.x}, ${action.from.y}) -> (${action.to.x}, ${action.to.y})`
    case 'drag_to':
      return `drag to (${action.to.x}, ${action.to.y})`
    case 'mouse_move':
      return `move to (${action.point.x}, ${action.point.y})`
    case 'type':
      return `type ${JSON.stringify(action.content.slice(0, 40))}`
    case 'hotkey':
      return `hotkey ${action.keys}`
    case 'press':
    case 'key_down':
    case 'key_up':
      return `${action.type} ${action.keys.join(' ')}`
    case 'scroll':
      return `scroll ${action.direction} at (${action.point.x}, ${action.point.y})`
    case 'scroll_by':
      return `scroll ${action.axis} by ${action.amount}`
    case 'wait':
      return `wait ${action.durationMs ?? 0}ms`
    default:
      return action.type
  }
}
