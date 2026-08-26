import { Annotation, END, START, StateGraph } from '@langchain/langgraph'
import {
  computerUseHistoryTokenBudget,
  tailWithinTokenBudget
} from '../../shared/computer-use-settings'
import {
  DEFAULT_COMPUTER_USE_STEP_BUDGET,
  MAX_COMPUTER_USE_REASONING_CHARS
} from '../../shared/computer-use-limits'
import { CurrentTaskBrief } from '../tasks/current-task-brief'
import {
  createTaskPhaseReporter,
  formatTaskExecutionPlanContext
} from '../tasks/task-execution-plan-service'
import { TASK_GUIDANCE_APPLIED_TRACE } from '../tasks/task-guide'
import type { ComputerUsePhase } from '../tasks/task-step-details'
import type { VisionAction } from './vision-action'
import {
  RecoverableVisionError,
  type VisionGroundingInput,
  type VisionGroundingResult,
  type VisionScreen,
  type VisionStepObservation,
  type VisionTaskDeps,
  type VisionTaskResult
} from './vision-agent'
import type { VisionPolicyDecision, VisionPolicyHistoryStep } from './model-adapters/types'
import { uiTarsAdapter } from './model-adapters/ui-tars'

type WorkflowRoute =
  | 'gate'
  | 'pause'
  | 'capture'
  | 'decide'
  | 'advance'
  | 'handle_decision'
  | 'execute'
  | 'end'

const WorkflowState = Annotation.Root({
  route: Annotation<WorkflowRoute>()
})

export interface VisionTaskGraphDeps extends Omit<VisionTaskDeps, 'ground'> {
  decide: (input: VisionGroundingInput) => Promise<VisionGroundingResult>
}

interface CapturedStep {
  shot: Awaited<ReturnType<VisionScreen['capture']>>
  startedAt: number
  guidance: readonly string[]
  history: string[]
  promptContext: string
  currentMilestone?: string
}

/**
 * One local LangGraph workflow for the screenshot-first operator pipeline.
 * Binary screenshots and live Electron objects stay at injected boundaries;
 * SQLite task history remains the durable source of truth.
 */
export async function runVisionTaskGraph(
  goal: string,
  deps: VisionTaskGraphDeps
): Promise<VisionTaskResult> {
  const runtime = new VisionTaskGraphRuntime(goal, deps)
  const graph = new StateGraph(WorkflowState)
    .addNode('gate', () => runtime.gate())
    .addNode('pause', () => runtime.pause())
    .addNode('capture', () => runtime.capture())
    .addNode('decide', () => runtime.decide())
    .addNode('advance', () => runtime.advanceMilestone())
    .addNode('handle_decision', () => runtime.handleDecision())
    .addNode('execute', () => runtime.execute())
    .addEdge(START, 'gate')
    .addConditionalEdges('gate', route, {
      pause: 'pause',
      capture: 'capture',
      end: END
    })
    .addEdge('pause', 'gate')
    .addConditionalEdges('capture', route, {
      decide: 'decide',
      gate: 'gate',
      end: END
    })
    .addEdge('decide', 'handle_decision')
    .addConditionalEdges('advance', route, { gate: 'gate', end: END })
    .addConditionalEdges('handle_decision', route, {
      execute: 'execute',
      advance: 'advance',
      gate: 'gate',
      end: END
    })
    .addConditionalEdges('execute', route, { gate: 'gate', end: END })
    .compile()

  runtime.start()
  try {
    await graph.invoke(
      { route: 'gate' },
      { recursionLimit: runtime.maxPlanningSteps * 12 + 20, signal: deps.signal }
    )
  } catch (error) {
    if (!deps.signal?.aborted) throw error
    runtime.stopAfterAbort()
  }
  return runtime.result()
}

function route(state: typeof WorkflowState.State): WorkflowRoute {
  return state.route
}

class VisionTaskGraphRuntime {
  readonly maxPlanningSteps: number
  private readonly now: () => number
  private readonly taskBrief: CurrentTaskBrief
  private readonly retrievedFacts: string[]
  private readonly parseResponse: NonNullable<VisionTaskDeps['parseResponse']>
  private readonly reportPhase: (phaseIndex: number) => void
  private readonly basePlanContext: string
  private readonly checkpointInterval: number
  private readonly visualHistoryFrames: number
  private readonly steps: string[] = []
  private readonly policyHistory: VisionPolicyHistoryStep[] = []
  private readonly verifiedActions: string[] = []
  private previousVerifiedAction?: {
    action: VisionAction
    coordinateFrame: ReturnType<typeof coordinateFrame>
  }
  private handoffs = 0
  private modelStep = 0
  private phaseIndex = 0
  private captured?: CapturedStep
  private decision?: VisionPolicyDecision
  private actionResponse?: string
  private actionModelInput?: string
  private pendingPolicyHistory?: VisionPolicyHistoryStep
  private currentReasoning = ''
  private finalResult?: VisionTaskResult

  constructor(
    goal: string,
    private readonly deps: VisionTaskGraphDeps
  ) {
    this.now = deps.now ?? Date.now
    this.taskBrief = new CurrentTaskBrief(goal)
    this.retrievedFacts = deps.retrievedFacts ?? []
    this.parseResponse = deps.parseResponse ?? uiTarsAdapter.parseResponse
    this.reportPhase = createTaskPhaseReporter(deps.plan, deps.onPhase)
    this.basePlanContext = deps.plan ? formatTaskExecutionPlanContext(deps.plan) : ''
    this.checkpointInterval = Math.max(1, Math.floor(deps.checkpointInterval ?? 9))
    this.visualHistoryFrames = Math.max(0, Math.floor(deps.visualHistoryFrames ?? 2))
    this.maxPlanningSteps = Math.max(
      1,
      Math.floor(deps.maxPlanningSteps ?? DEFAULT_COMPUTER_USE_STEP_BUDGET)
    )
  }

  start(): void {
    this.reportPhase(0)
  }

  stopAfterAbort(): void {
    if (this.finalResult) return
    const summary = this.deps.guard.snapshot().reason || 'Stopped'
    this.progress('stopped', summary)
    this.note(`stopped: ${summary}`)
    this.finish(false, summary)
  }

  result(): VisionTaskResult {
    return (
      this.finalResult ?? {
        ok: false,
        summary: 'The visual workflow ended without a final result.',
        steps: [...this.steps],
        handoffs: this.handoffs
      }
    )
  }

  gate(): { route: WorkflowRoute } {
    if (this.finalResult) return { route: 'end' }
    if (this.modelStep >= this.maxPlanningSteps) {
      const summary = `Computer use stopped after ${this.maxPlanningSteps} planning steps.`
      this.progress('failed', 'Reached the planning-step limit')
      this.note(summary)
      this.finish(false, summary)
      return { route: 'end' }
    }
    if (this.deps.guard.canActuate()) return { route: 'capture' }
    const snapshot = this.deps.guard.snapshot()
    if (snapshot.state === 'paused') return { route: 'pause' }
    const summary = snapshot.reason || 'Stopped'
    this.progress('stopped', summary)
    this.note(`stopped: ${summary}`)
    this.finish(false, summary)
    return { route: 'end' }
  }

  async pause(): Promise<{ route: WorkflowRoute }> {
    const reason = this.deps.guard.snapshot().reason || 'Waiting for you'
    this.progress('paused', reason)
    this.note(`paused: ${reason}`)
    await this.deps.guard.waitUntilRunnable()
    if (!this.deps.guard.isHalted) this.note('resumed by the user')
    return { route: 'gate' }
  }

  async capture(): Promise<{ route: WorkflowRoute }> {
    this.modelStep += 1
    this.progress('observing', 'Reading the current screen')
    const startedAt = this.now()
    this.taskBrief.accept(this.deps.takeGuidance?.() ?? [])
    const guidance = [...this.taskBrief.guidance]
    const currentPhase = this.deps.plan?.phases[this.phaseIndex]
    const planContext = [
      this.basePlanContext,
      currentPhase
        ? `Current milestone: ${currentPhase.title}\nInterpret this milestone against the current Task brief above. Mark it complete only after its result is visible.`
        : ''
    ]
      .filter(Boolean)
      .join('\n\n')
    const history = tailWithinTokenBudget(
      planContext ? [planContext, ...this.steps] : this.steps,
      computerUseHistoryTokenBudget(this.deps.contextTokens ?? 2_048)
    )
    const durableObjective = this.taskBrief.guidance.reduce(
      (safeObjective, privateText) =>
        safeObjective.split(privateText).join(TASK_GUIDANCE_APPLIED_TRACE),
      this.taskBrief.objective
    )
    const promptContext = [
      `Task: ${durableObjective}`,
      this.retrievedFacts.length ? `Past task facts:\n${this.retrievedFacts.join('\n')}` : '',
      history.length ? `Current task history:\n${history.join('\n')}` : ''
    ]
      .filter(Boolean)
      .join('\n\n')
    try {
      const shot = await this.deps.screen.capture()
      this.captured = {
        shot,
        startedAt,
        guidance,
        history,
        promptContext,
        currentMilestone: currentPhase?.title
      }
      this.decision = undefined
      this.actionResponse = undefined
      this.actionModelInput = undefined
      return { route: 'decide' }
    } catch (error) {
      const message = errorMessage(error, 'computer use capture failed')
      this.observe({
        phase: error instanceof RecoverableVisionError ? 'checking' : 'failed',
        promptContext,
        screenshot: { image: '', bounds: { width: 0, height: 0 } },
        durationMs: this.now() - startedAt,
        result: error instanceof RecoverableVisionError ? 'blocked' : 'error',
        error: message
      })
      if (error instanceof RecoverableVisionError) {
        this.note(`rejected observation: ${message}`)
        this.progress('checking', 'Refreshing the browser observation')
        this.checkpoint()
        return { route: 'gate' }
      }
      this.note(`visual capture failed: ${message}`)
      this.finish(false, message)
      return { route: 'end' }
    }
  }

  async decide(): Promise<{ route: WorkflowRoute }> {
    const captured = this.requireCaptured()
    this.progress('thinking', 'Reviewing direction, milestone, and next action')
    this.beginReasoning()
    try {
      const grounding = await this.deps.decide(this.groundingInput(captured))
      this.actionResponse = grounding.response
      this.actionModelInput = grounding.modelInput
      this.decision =
        grounding.decision ??
        this.parseResponse(grounding.response, captured.shot.bounds, coordinateFrame(captured.shot))
      this.pendingPolicyHistory = {
        response: grounding.response,
        actionText: this.decision.actionText,
        ...(grounding.screenshotDataUrl ? { screenshotDataUrl: grounding.screenshotDataUrl } : {})
      }
      return { route: 'handle_decision' }
    } catch (error) {
      if (this.deps.signal?.aborted) {
        this.stopAfterAbort()
        return { route: 'handle_decision' }
      }
      const message = errorMessage(error, 'visual decision failed')
      this.observe({
        phase: 'failed',
        promptContext: this.actionModelInput ?? captured.promptContext,
        screenshot: captured.shot,
        rawResponse: this.actionResponse,
        reasoning: this.currentReasoning,
        durationMs: this.now() - captured.startedAt,
        result: 'error',
        error: message
      })
      this.note(`visual decision failed: ${message}`)
      this.finish(false, `Visual decision failed: ${message}`)
      return { route: 'handle_decision' }
    } finally {
      this.endReasoning()
    }
  }

  advanceMilestone(): { route: WorkflowRoute } {
    if (this.decision?.kind !== 'phase_complete' && this.decision?.kind !== 'done') {
      this.finish(false, 'Only the milestone judge can advance the execution plan.')
      return { route: 'end' }
    }
    const completed = this.deps.plan?.phases[this.phaseIndex]
    this.note(`milestone complete: ${completed?.title ?? this.decision.summary}`)
    const hasNextPhase = Boolean(
      this.deps.plan && this.phaseIndex < this.deps.plan.phases.length - 1
    )
    if (!hasNextPhase) {
      this.progress('complete', this.decision.summary)
      this.finish(true, this.decision.summary)
      return { route: 'end' }
    }
    // A model trajectory belongs to one milestone. Do not let actions from a
    // completed milestone bias the first decision for the next milestone.
    this.policyHistory.length = 0
    this.pendingPolicyHistory = undefined
    this.phaseIndex += 1
    this.reportPhase(this.phaseIndex)
    return { route: 'gate' }
  }

  async handleDecision(): Promise<{ route: WorkflowRoute }> {
    if (this.finalResult) return { route: 'end' }
    const decision = this.decision
    if (!decision) {
      this.finish(false, 'The action model returned no decision.')
      return { route: 'end' }
    }
    if (decision.kind === 'actions') {
      const repeatedClick = decision.actions.find((action) =>
        isSameClickAction(action, this.previousVerifiedAction?.action)
      )
      if (repeatedClick) {
        const summary = `Repeated click blocked at (${repeatedClick.point.x}, ${repeatedClick.point.y}). The previous click marker shows where it landed; choose a different visible target or rethink.`
        this.discardPendingPolicyHistory()
        this.observeDecision('blocked', summary)
        this.note(summary)
        this.progress('checking', 'Choosing a different target after a repeated click')
        this.checkpoint()
        return { route: 'gate' }
      }
      this.observeDecision('reviewed')
      this.note(`action approved: ${decision.actionText}`)
      this.checkpoint()
      return { route: 'execute' }
    }
    if (decision.kind === 'phase_complete') {
      this.discardPendingPolicyHistory()
      this.observeDecision('terminal')
      this.checkpoint()
      return { route: 'advance' }
    }
    if (decision.kind === 'rethink') {
      this.discardPendingPolicyHistory()
      this.observeDecision('blocked', decision.summary)
      this.note(`${decision.direction}: ${decision.summary}`)
      this.progress('checking', 'Taking a fresh observation after rethinking the action')
      this.checkpoint()
      return { route: 'gate' }
    }
    if (decision.kind === 'invalid') {
      this.discardPendingPolicyHistory()
      this.observeDecision('parse_failed', decision.error)
      this.note(`${decision.error}; re-observing`)
      this.checkpoint()
      return { route: 'gate' }
    }
    if (decision.kind === 'wait') {
      this.discardPendingPolicyHistory()
      this.progress('waiting', `Waiting ${decision.durationMs} ms`)
      await new Promise((resolve) => setTimeout(resolve, decision.durationMs))
      this.observeDecision('wait')
      this.note(`wait ${decision.durationMs}ms`)
      this.checkpoint()
      return { route: 'gate' }
    }
    if (decision.kind === 'handoff') {
      this.discardPendingPolicyHistory()
      this.progress('waiting', 'Waiting for you to finish this step')
      this.observeDecision('handoff')
      this.handoffs += 1
      this.note(`handoff: ${decision.reason}`)
      this.checkpoint()
      await this.deps.waitForUser(decision.reason)
      if (!this.deps.guard.isHalted) this.note('resumed by the user')
      return { route: 'gate' }
    }
    if (decision.kind === 'done' && this.deps.plan?.phases.length) {
      // The execution plan is the task lifecycle SSOT. A model-level `done`
      // verdict is stronger than completion of the current milestone, but it
      // must not skip the remaining visible checks or release the specialist.
      // Advance one milestone and let the next screenshot verify the next one.
      this.discardPendingPolicyHistory()
      this.observeDecision('terminal')
      this.checkpoint()
      return { route: 'advance' }
    }
    this.discardPendingPolicyHistory()
    this.observeDecision('terminal')
    this.note(`${decision.kind}: ${decision.summary}`)
    this.checkpoint()
    this.finish(decision.kind === 'done', decision.summary)
    return { route: 'end' }
  }

  async execute(): Promise<{ route: WorkflowRoute }> {
    const captured = this.requireCaptured()
    const decision = this.decision
    if (decision?.kind !== 'actions') {
      this.finish(false, 'The visual workflow reached execution without an action.')
      return { route: 'end' }
    }
    const mappedActions: VisionAction[] = []
    let actionIndex = 0
    let blocked = false
    let executionHandoff: string | undefined
    let executionRejection: string | undefined
    try {
      for (const [index, action] of decision.actions.entries()) {
        actionIndex = index
        if (!this.deps.guard.canActuate()) {
          blocked = true
          break
        }
        this.progress(
          'acting',
          action.type === 'type'
            ? describeAction(action)
            : decision.actionText || describeAction(action)
        )
        const actuation = await this.deps.screen.actuate(action, {
          decisionRationale: decision.decisionRationale
        })
        if (actuation?.handoff) {
          executionHandoff = actuation.handoff
          break
        }
        if (actuation?.rejected) {
          executionRejection = actuation.rejected
          this.note(`rejected action: ${actuation.rejected}`)
          break
        }
        this.deps.guard.countStep()
        const verified = describeAction(action)
        this.note(verified)
        this.verifiedActions.push(verified)
        this.previousVerifiedAction = {
          action,
          coordinateFrame: coordinateFrame(captured.shot)
        }
        if (actuation?.mappedAction) mappedActions.push(actuation.mappedAction)
      }
    } catch (error) {
      this.discardPendingPolicyHistory()
      if (this.deps.signal?.aborted) {
        this.stopAfterAbort()
        return { route: 'end' }
      }
      const message = errorMessage(error, 'computer use action failed')
      const failedAction = decision.actions[actionIndex]
      this.observe({
        phase: 'failed',
        promptContext: this.actionModelInput ?? captured.promptContext,
        screenshot: captured.shot,
        rawResponse: this.actionResponse,
        reasoning: this.currentReasoning,
        decisionSummary:
          decision.actionText || (failedAction ? describeAction(failedAction) : 'Action failed'),
        decisionRationale: decision.decisionRationale,
        parsedAction: failedAction ?? null,
        parsedActions: decision.actions,
        failedActionIndex: actionIndex,
        ...(mappedActions[0] ? { mappedAction: mappedActions[0] } : {}),
        ...(mappedActions.length ? { mappedActions } : {}),
        durationMs: this.now() - captured.startedAt,
        result: 'error',
        error: message
      })
      this.checkpoint()
      this.finish(false, message)
      return { route: 'end' }
    }
    if (executionHandoff) {
      this.discardPendingPolicyHistory()
      this.progress('waiting', 'Waiting for you to finish this step')
      this.observeDecision('handoff', executionHandoff)
      this.handoffs += 1
      this.note(`handoff: ${executionHandoff}`)
      this.checkpoint()
      await this.deps.waitForUser(executionHandoff)
      if (!this.deps.guard.isHalted) this.note('resumed by the user')
      return { route: 'gate' }
    }
    if (executionRejection) {
      this.discardPendingPolicyHistory()
      this.observeDecision('blocked', executionRejection)
      this.progress('checking', 'Taking a fresh observation after the action was not executed')
      this.checkpoint()
      return { route: 'gate' }
    }
    if (blocked) this.discardPendingPolicyHistory()
    else this.commitPendingPolicyHistory()
    const blockedPhase: ComputerUsePhase = this.deps.guard.isHalted ? 'stopped' : 'paused'
    this.observe({
      phase: blocked ? blockedPhase : 'checking',
      promptContext: this.actionModelInput ?? captured.promptContext,
      screenshot: captured.shot,
      rawResponse: this.actionResponse,
      reasoning: this.currentReasoning,
      decisionSummary: decision.actionText || decision.actions.map(describeAction).join('; '),
      decisionRationale: decision.decisionRationale,
      parsedAction: decision.actions[0],
      parsedActions: decision.actions,
      ...(mappedActions[0] ? { mappedAction: mappedActions[0] } : {}),
      ...(mappedActions.length ? { mappedActions } : {}),
      durationMs: this.now() - captured.startedAt,
      result: blocked ? 'blocked' : 'actuated'
    })
    this.progress(
      blocked ? blockedPhase : 'checking',
      blocked ? 'Action paused' : 'Checking the result'
    )
    this.checkpoint()
    return { route: 'gate' }
  }

  private groundingInput(captured: CapturedStep): VisionGroundingInput {
    return {
      goal: this.taskBrief.objective,
      image: captured.shot.image,
      history: captured.history,
      retrievedFacts: this.retrievedFacts,
      policyHistory: this.policyHistory,
      guidance: captured.guidance,
      currentMilestone: captured.currentMilestone,
      verifiedActions: [...this.verifiedActions],
      previousVerifiedAction: this.previousVerifiedAction,
      coordinateFrame: coordinateFrame(captured.shot),
      signal: this.deps.signal,
      reportProgress: (action) => this.progress('thinking', action),
      reportReasoning: (text) => this.appendReasoning(text)
    }
  }

  private beginReasoning(): void {
    this.currentReasoning = ''
    this.deps.onReasoning?.({ step: this.modelStep, content: '', live: true })
  }

  private appendReasoning(text: string): void {
    if (!text) return
    this.currentReasoning = `${this.currentReasoning}${text}`.slice(
      -MAX_COMPUTER_USE_REASONING_CHARS
    )
    this.deps.onReasoning?.({
      step: this.modelStep,
      content: this.currentReasoning,
      live: true
    })
  }

  private endReasoning(): void {
    this.deps.onReasoning?.({
      step: this.modelStep,
      content: this.currentReasoning,
      live: false
    })
  }

  private observeDecision(result: VisionStepObservation['result'], error?: string): void {
    const captured = this.requireCaptured()
    const decision = this.decision
    this.observe({
      phase: result === 'handoff' || result === 'wait' ? 'waiting' : 'checking',
      promptContext: this.actionModelInput ?? captured.promptContext,
      screenshot: captured.shot,
      rawResponse: this.actionResponse,
      reasoning: this.currentReasoning,
      decisionSummary:
        error ||
        decision?.actionText ||
        (decision && 'summary' in decision ? decision.summary : undefined),
      decisionRationale: decision?.decisionRationale,
      parsedAction: decision?.kind === 'actions' ? decision.actions[0] : null,
      parsedActions: decision?.kind === 'actions' ? decision.actions : undefined,
      durationMs: this.now() - captured.startedAt,
      result,
      error
    })
  }

  private observe(detail: Omit<VisionStepObservation, 'step' | 'retrievedFacts'>): void {
    this.deps.onObservation?.({
      step: this.modelStep,
      retrievedFacts: this.retrievedFacts,
      ...detail
    })
  }

  private progress(phase: ComputerUsePhase, action: string): void {
    this.deps.onProgress?.({ phase, step: this.modelStep, action })
  }

  private note(line: string): void {
    this.steps.push(line)
    this.deps.onStep?.(line)
  }

  private checkpoint(): void {
    if (this.modelStep % this.checkpointInterval === 0) {
      this.deps.onCheckpoint?.(this.modelStep, this.steps)
    }
  }

  private trimVisualHistory(): void {
    const imageHistory = this.policyHistory.filter((step) => step.screenshotDataUrl)
    for (const old of imageHistory.slice(
      0,
      Math.max(0, imageHistory.length - this.visualHistoryFrames)
    )) {
      delete old.screenshotDataUrl
    }
  }

  private commitPendingPolicyHistory(): void {
    if (!this.pendingPolicyHistory) return
    this.policyHistory.push(this.pendingPolicyHistory)
    this.pendingPolicyHistory = undefined
    this.trimVisualHistory()
  }

  private discardPendingPolicyHistory(): void {
    this.pendingPolicyHistory = undefined
  }

  private requireCaptured(): CapturedStep {
    if (!this.captured) throw new Error('The visual workflow has no current screenshot.')
    return this.captured
  }

  private finish(ok: boolean, summary: string): void {
    this.finalResult = {
      ok,
      summary,
      steps: [...this.steps],
      handoffs: this.handoffs
    }
  }
}

function coordinateFrame(shot: Awaited<ReturnType<VisionScreen['capture']>>): {
  encoded: { width: number; height: number }
  source: { width: number; height: number }
} {
  const source = shot.metadata?.geometry?.sourceBounds
  return {
    encoded: shot.bounds,
    source: source ? { width: source.width, height: source.height } : shot.bounds
  }
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback
}

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
      return 'type text'
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

function isSameClickAction(
  action: VisionAction,
  previous: VisionAction | undefined
): action is Extract<VisionAction, { point: { x: number; y: number } }> {
  if (!previous || action.type !== previous.type) return false
  switch (action.type) {
    case 'click':
    case 'double_click':
    case 'right_click':
    case 'middle_click':
    case 'triple_click':
      return (
        'point' in previous &&
        action.point.x === previous.point.x &&
        action.point.y === previous.point.y
      )
    default:
      return false
  }
}
