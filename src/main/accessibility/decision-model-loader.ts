import { llm } from '../llm'
import { getComputerUseSettings } from '../computer-use-settings'
import { DECIDER_2B, listInstalled, loadComputerUseModel } from '../models-manager'
import { decisionRuntime, DecisionRuntimeError } from './decision-runtime'
import type { OptionDecision } from '../llm'
import { parseRemoteVisionModelId } from '../../shared/remote-vision-server'
import {
  currentRemoteScreenTaskSession,
  runWithRemoteScreenTaskSession
} from '../actions/remote-screen-session'
import { getRemoteVisionServerForModel } from '../vision/remote-vision-server'
import { decideWithOpenRouter, usesOpenRouterDecisions } from './remote-decision'

let swapFallbackActive = false

export function selectedDecisionModelId(): string {
  return getComputerUseSettings().decisionModelId ?? DECIDER_2B.id
}

/** Run one AX decision phase with the selected Decision model, then return the
 * shared llama.cpp process to the saved Chat model before vision recovery. */
export async function withDecisionModel<T>(task: () => Promise<T>): Promise<T> {
  const modelId = selectedDecisionModelId()
  const remote = getRemoteVisionServerForModel(modelId, 'decision')
  // Each remote decision binds only its own request. Keep the outer task bound
  // to Chat so reasoning recovery does not accidentally use the Decider.
  if (remote) return task()
  if (!(await listInstalled()).includes(modelId)) {
    throw new Error(
      `The selected Decision model is not downloaded: ${modelId}. Download it from the Computer Use catalog first.`
    )
  }
  try {
    await decisionRuntime.start(modelId)
  } catch (error) {
    if (!(error instanceof DecisionRuntimeError) || error.code !== 'out_of_memory') throw error
    console.warn(
      '[computer-use] dedicated Decision runtime out of memory; using explicit swap fallback'
    )
    const alreadyLoaded = llm.activeModelInfo()?.id === modelId
    if (!alreadyLoaded) {
      const loaded = await loadComputerUseModel(modelId)
      if (!loaded.success) throw new Error(loaded.error ?? 'The Decision model could not load.')
      await llm.restart()
    }
    try {
      swapFallbackActive = true
      return await task()
    } finally {
      swapFallbackActive = false
      if (!alreadyLoaded) {
        llm.restoreSelectedModel()
        await llm.restart()
      }
    }
  }
  try {
    return await task()
  } finally {
    await decisionRuntime.shutdown()
  }
}

export function parseRemoteDecision(raw: string, optionCount: number): OptionDecision {
  const normalized = raw
    .replace(/<think\b[^>]*>[\s\S]*?<\/think>/gi, '')
    .replace(/^```(?:json)?\s*|\s*```$/gi, '')
    .trim()
  const value = JSON.parse(normalized) as { choice?: unknown; probabilities?: unknown }
  const choice =
    typeof value.choice === 'number'
      ? Math.floor(value.choice)
      : typeof value.choice === 'string'
        ? 'ABCDEFGHIJ'.indexOf(value.choice.trim().toUpperCase())
        : -1
  if (choice < 0 || choice >= optionCount) {
    throw new Error('The remote Decision model returned an invalid choice.')
  }
  const supplied = Array.isArray(value.probabilities)
    ? value.probabilities
        .slice(0, optionCount)
        .map((item) => (typeof item === 'number' && Number.isFinite(item) && item >= 0 ? item : 0))
    : []
  const total = supplied.reduce((sum, probability) => sum + probability, 0)
  const probabilities =
    supplied.length === optionCount && total > 0
      ? supplied.map((probability) => probability / total)
      : Array.from({ length: optionCount }, (_, index) => (index === choice ? 1 : 0))
  return { choice, confidence: probabilities[choice] ?? 1, probabilities }
}

async function decideWithRemoteModel(
  remote: NonNullable<ReturnType<typeof getRemoteVisionServerForModel>>,
  context: string,
  question: string,
  options: readonly string[],
  signal?: AbortSignal
): Promise<OptionDecision> {
  if (usesOpenRouterDecisions(remote)) {
    return decideWithOpenRouter(remote, context, question, options, signal)
  }
  const session = currentRemoteScreenTaskSession()
  return runWithRemoteScreenTaskSession(
    {
      taskKind: session?.taskKind ?? 'computer_use',
      modelStrategy: session?.modelStrategy ?? getComputerUseSettings().modelStrategy,
      activeServer: remote
    },
    async () => {
      const content = await llm.chatMessages(
        [
          {
            role: 'system',
            content:
              'Choose one supplied option. Return JSON only: {"choice":0,"probabilities":[0.7,0.3]}. choice is a zero-based index. probabilities must match the option count.'
          },
          {
            role: 'user',
            content: [
              `Context:\n${context}`,
              `Question: ${question}`,
              'Options:',
              ...options.map((option, index) => `${index}: ${option}`)
            ].join('\n')
          }
        ],
        undefined,
        256,
        { temperature: 0, disableThinking: true, signal }
      )
      return parseRemoteDecision(content, options.length)
    }
  )
}

export async function decideWithDecisionModel(
  context: string,
  question: string,
  options: readonly string[],
  signal?: AbortSignal
): Promise<OptionDecision> {
  const selected = selectedDecisionModelId()
  if (parseRemoteVisionModelId(selected)) {
    const remote = getRemoteVisionServerForModel(selected, 'decision')
    if (!remote) throw new Error('The selected remote Decision model is not available.')
    return decideWithRemoteModel(remote, context, question, options, signal)
  }
  if (decisionRuntime.running) return decisionRuntime.decide(context, question, options, signal)
  if (swapFallbackActive) return llm.decideOptions(context, question, options, signal)
  throw new DecisionRuntimeError(
    'The dedicated Decision runtime stopped before selection.',
    'startup'
  )
}

/** Temporarily yield the shared llama.cpp process to the saved reasoning model
 * while an active Decision-model AX loop performs one visual recovery action. */
export async function withReasoningModel<T>(task: () => Promise<T>): Promise<T> {
  if (decisionRuntime.running) return task()
  const modelId = selectedDecisionModelId()
  const decisionModelLoaded = llm.activeModelInfo()?.id === modelId
  if (!decisionModelLoaded) return task()
  llm.restoreSelectedModel()
  await llm.restart()
  let result: T | undefined
  let taskError: unknown
  try {
    result = await task()
  } catch (error) {
    taskError = error
  }
  const loaded = await loadComputerUseModel(modelId)
  if (!loaded.success) throw new Error(loaded.error ?? 'The Decision model could not resume.')
  await llm.restart()
  if (taskError !== undefined) throw taskError
  return result as T
}
