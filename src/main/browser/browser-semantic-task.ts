import { llm } from '../llm'
import type { TaskExecutionPlan } from '../../shared/task-execution-plan'
import type { BrowserTaskStatus } from '../../shared/browser-session'
import type { TaskRetryCheckpoint } from '../tasks/task-retry'
import type { VisionGuard } from '../vision/vision-guard'
import type { BrowserDriver } from './browser-driver'
import {
  runWebTask,
  STEP_RESPONSE_FORMAT,
  type AgentDriver,
  type WebTaskResult
} from './web-task-agent'

const MODEL_RECOVERY_TIMEOUT_MS = 75_000

function isLocalModelConnectionRefusal(error: unknown): boolean {
  const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
  return /ECONNREFUSED/i.test(detail) && /127\.0\.0\.1(?::8439)?/i.test(detail)
}

async function restartModelWithinBound(): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error('Model reconnect timed out after 75 seconds.')),
      MODEL_RECOVERY_TIMEOUT_MS
    )
    timer.unref()
  })
  await Promise.race([llm.restart(), timeout]).finally(() => clearTimeout(timer))
}

interface BrowserSemanticTaskInput {
  goal: string
  activeDriver: () => BrowserDriver
  guard: VisionGuard
  checkpoint?: TaskRetryCheckpoint
  plan: TaskExecutionPlan
  takeGuidance: () => readonly string[]
  waitForTakeover: (why: string) => Promise<'resumed' | 'cancelled'>
  recordStep: (note: string) => void
  setState: (status: BrowserTaskStatus, summary?: string) => void
  onPhase: (phaseId: string) => void
}

/** Compatibility operator for a general Chat model. Visual specialists use
 * browser-visual-task instead. Both paths receive the same task lifecycle. */
export function runBrowserSemanticTask(input: BrowserSemanticTaskInput): Promise<WebTaskResult> {
  const driver: AgentDriver = {
    snapshot: () => input.activeDriver().snapshot(),
    navigate: (target) => input.activeDriver().navigate(target),
    click: (element) => input.activeDriver().click(element),
    type: (element, text) => input.activeDriver().type(element, text),
    pressKey: (key) => input.activeDriver().pressKey(key)
  }
  return runWebTask(input.goal, '', {
    driver,
    decide: (prompt) => decideWithOneReconnect(input, prompt),
    waitForTakeover: input.waitForTakeover,
    onStep: input.recordStep,
    shouldStop: () => input.guard.isHalted,
    checkpointHistory: input.checkpoint
      ? [
          ...input.checkpoint.steps,
          ...(input.checkpoint.currentAction
            ? [`Last action: ${input.checkpoint.currentAction}`]
            : []),
          ...(input.checkpoint.summary
            ? [`Earlier attempt ended: ${input.checkpoint.summary}`]
            : [])
        ]
      : undefined,
    takeGuidance: input.takeGuidance,
    plan: input.plan,
    onPhase: input.onPhase,
    settleAfterAction: () =>
      new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 350)
        timer.unref()
      })
  })
}

async function decideWithOneReconnect(
  input: BrowserSemanticTaskInput,
  prompt: string
): Promise<string> {
  const decide = (): Promise<string> =>
    llm.chat(prompt, [], 60_000, 400, {
      disableThinking: true,
      responseFormat: STEP_RESPONSE_FORMAT
    })
  try {
    return await decide()
  } catch (error) {
    if (!isLocalModelConnectionRefusal(error)) throw error
    input.recordStep('model disconnected; reconnecting once')
    input.setState('reconnecting', 'The local model disconnected. Reconnecting once.')
    await restartModelWithinBound()
    input.setState('running', '')
    input.recordStep('model reconnected')
    return decide()
  }
}
