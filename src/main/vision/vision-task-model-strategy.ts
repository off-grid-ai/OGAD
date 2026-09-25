import { llm } from '../llm'
import { getComputerUseSettings } from '../computer-use-settings'
import { getWebUseSettings } from '../web-use-settings'
import { getActiveModel, resolveModelIdentity, type ModelIdentity } from '../models-manager'
import type {
  ComputerUseActiveModel,
  ComputerUseActiveModelProjection,
  ComputerUseModelStrategy
} from '../../shared/computer-use-settings'
import { parseRemoteVisionModelId, remoteVisionModelId } from '../../shared/remote-vision-server'
import { withGrounder, selectedGrounderModelId } from './grounder-loader'
import { createHybridVisionGrounder, productionHybridReasoner } from './hybrid-vision-grounder'
import {
  matchVisionModelAdapter,
  resolveVisionModelAdapterForStrategy
} from './model-adapters'
import {
  bonsaiVisionOperatorAdapter,
  generalVisionOperatorAdapter
} from './model-adapters/general-vision-operator'
import type {
  VisionModelAdapter,
  VisionModelArtifacts,
  VisionPolicyInput
} from './model-adapters/types'
import { createVisionGrounder } from './vision-policy-runner'
import { getActiveRemoteVisionServer, getRemoteVisionServerForModel } from './remote-vision-server'
import type { VisionGroundingInput, VisionGroundingResult } from './vision-agent'
import {
  currentRemoteScreenTaskSession,
  recordComputerUseMetric,
  recordComputerUseModelCall
} from '../actions/remote-screen-session'
import {
  decideWithDecisionModel,
  selectedDecisionModelId,
  withDecisionModel,
  withReasoningModel
} from '../accessibility/decision-model-loader'
import type { OptionDecision } from '../llm'

export interface VisionTaskModelSession {
  adapter: VisionModelAdapter
  identity: ModelIdentity
  decide(input: VisionGroundingInput): Promise<VisionGroundingResult>
}

interface VisionModelSelection {
  adapter: VisionModelAdapter
  modelId: string
}

interface RemoteModelSelection {
  id: string
  model: string
}

export interface VisionTaskModelStrategyDependencies {
  strategy(): ComputerUseModelStrategy
  activeArtifacts(): VisionModelArtifacts | null
  activeRemote(): RemoteModelSelection | null
  selectedChatId(): string | null
  selectedSpecialistId(): string
  selectedDecisionId?(): string
  resolveIdentity(modelId: string): Promise<ModelIdentity>
  withSpecialist<T>(task: () => Promise<T>): Promise<{ result: T }>
  runReasoner: typeof productionHybridReasoner
  withDecision<T>(task: () => Promise<T>): Promise<T>
  withReasoning<T>(task: () => Promise<T>): Promise<T>
  decideOptions(
    context: string,
    question: string,
    options: readonly string[],
    signal?: AbortSignal
  ): Promise<OptionDecision>
}

const productionDependencies: VisionTaskModelStrategyDependencies = {
  strategy: () =>
    currentRemoteScreenTaskSession()?.modelStrategy ?? getComputerUseSettings().modelStrategy,
  activeArtifacts: () => llm.activeModelArtifacts(),
  activeRemote: () => {
    const session = currentRemoteScreenTaskSession()
    return session ? session.activeServer : getActiveRemoteVisionServer()
  },
  selectedChatId: getActiveModel,
  selectedSpecialistId: selectedGrounderModelId,
  selectedDecisionId: selectedDecisionModelId,
  resolveIdentity: resolveModelIdentity,
  withSpecialist: withGrounder,
  runReasoner: productionHybridReasoner,
  withDecision: withDecisionModel,
  withReasoning: withReasoningModel,
  decideOptions: decideWithDecisionModel
}

async function projectedModel(
  role: ComputerUseActiveModel['role'],
  modelId: string,
  remote: boolean,
  dependencies: VisionTaskModelStrategyDependencies
): Promise<ComputerUseActiveModel> {
  const identity = await dependencies.resolveIdentity(modelId)
  return { role, ...identity, remote }
}

/** Canonical read-only model-role projection for Active Models. */
export async function getComputerUseActiveModelProjection(
  dependencies: VisionTaskModelStrategyDependencies = productionDependencies,
  options: { decisionSpecialistUsesReasoner?: boolean } = {}
): Promise<ComputerUseActiveModelProjection> {
  const strategy = dependencies.strategy()
  const remote = dependencies.activeRemote()
  const chatModelId = remote
    ? remoteVisionModelId(remote.id, remote.model)
    : dependencies.selectedChatId()
  const specialistModelId = dependencies.selectedSpecialistId()
  const remoteSpecialist = getRemoteVisionServerForModel(specialistModelId, 'grounding')
  if (strategy === 'same_as_chat') {
    return {
      strategy,
      strategyLabel: 'Same as Chat',
      models: chatModelId
        ? [await projectedModel('reasoner', chatModelId, Boolean(remote), dependencies)]
        : []
    }
  }
  if (strategy === 'separate_specialist') {
    return {
      strategy,
      strategyLabel: 'Specialist',
      models: [
        await projectedModel(
          'grounding_specialist',
          specialistModelId,
          Boolean(remoteSpecialist),
          dependencies
        )
      ]
    }
  }
  if (strategy === 'decision_plus_specialist') {
    const decisionModelId = dependencies.selectedDecisionId?.() ?? selectedDecisionModelId()
    const remoteDecision = getRemoteVisionServerForModel(decisionModelId, 'decision')
    const usesReasoner = options.decisionSpecialistUsesReasoner ?? true
    const models: ComputerUseActiveModel[] = [
      await projectedModel('decision', decisionModelId, Boolean(remoteDecision), dependencies)
    ]
    if (usesReasoner && chatModelId) {
      models.push(await projectedModel('reasoner', chatModelId, Boolean(remote), dependencies))
    }
    models.push(
      await projectedModel(
        'grounding_specialist',
        specialistModelId,
        Boolean(remoteSpecialist),
        dependencies
      )
    )
    return {
      strategy,
      strategyLabel: usesReasoner ? 'Decision + Reasoning + Specialist' : 'Decision + Specialist',
      models
    }
  }
  if (strategy === 'decision_plus_reasoning') {
    const decisionModelId = dependencies.selectedDecisionId?.() ?? selectedDecisionModelId()
    const remoteDecision = getRemoteVisionServerForModel(decisionModelId, 'decision')
    const models: ComputerUseActiveModel[] = [
      await projectedModel('decision', decisionModelId, Boolean(remoteDecision), dependencies)
    ]
    if (chatModelId) {
      models.push(await projectedModel('reasoner', chatModelId, Boolean(remote), dependencies))
    }
    return { strategy, strategyLabel: 'Decision + Reasoning', models }
  }
  const models: ComputerUseActiveModel[] = []
  if (chatModelId) {
    models.push(await projectedModel('reasoner', chatModelId, Boolean(remote), dependencies))
  }
  models.push(
    await projectedModel(
      'grounding_specialist',
      specialistModelId,
      Boolean(remoteSpecialist),
      dependencies
    )
  )
  return { strategy, strategyLabel: 'Reasoning + Specialist', models }
}

/** Web Use has its own strategy settings but shares the installed model runtimes. */
export function getWebUseActiveModelProjection(): Promise<ComputerUseActiveModelProjection> {
  return getComputerUseActiveModelProjection(
    {
      ...productionDependencies,
      strategy: () => getWebUseSettings().modelStrategy,
      selectedDecisionId: () => getWebUseSettings().decisionModelId ?? selectedDecisionModelId()
    },
    { decisionSpecialistUsesReasoner: false }
  )
}

function activeChatSelection(
  dependencies: VisionTaskModelStrategyDependencies
): VisionModelSelection {
  const remote = dependencies.activeRemote()
  if (remote) {
    return {
      adapter: generalVisionOperatorAdapter,
      modelId: remoteVisionModelId(remote.id, remote.model)
    }
  }
  const artifacts = dependencies.activeArtifacts()
  if (!artifacts) {
    throw new Error('Load a Chat model with vision support before you start this task.')
  }
  return {
    adapter: resolveVisionModelAdapterForStrategy(artifacts, 'same_as_chat'),
    modelId: artifacts.id
  }
}

function activeSpecialistSelection(
  dependencies: VisionTaskModelStrategyDependencies
): VisionModelSelection {
  const modelId = dependencies.selectedSpecialistId()
  return { adapter: matchSpecialistVisionModelAdapter(modelId), modelId }
}

/** Match the selected specialist by its real model-family id, including remote inventory ids.
 * Remote GUI specialists keep their native action protocol; they are not generic Chat planners. */
export function matchSpecialistVisionModelAdapter(modelId: string): VisionModelAdapter {
  const familyId = parseRemoteVisionModelId(modelId)?.modelId ?? modelId
  return matchVisionModelAdapter({
    id: familyId,
    primaryFile: familyId,
    projectorFile: null,
    availableFiles: []
  })
}

async function directSession(
  environment: VisionPolicyInput['operatorEnvironment'],
  selection: VisionModelSelection,
  dependencies: VisionTaskModelStrategyDependencies
): Promise<VisionTaskModelSession> {
  const role =
    dependencies.strategy() === 'same_as_chat' ||
    dependencies.strategy() === 'decision_plus_reasoning'
      ? 'reasoningCalls'
      : 'groundingCalls'
  const decide = createVisionGrounder(selection.adapter, environment)
  const identity = await dependencies.resolveIdentity(selection.modelId)
  return {
    adapter: selection.adapter,
    identity,
    decide: (input) => {
      recordComputerUseMetric(role)
      input.reportModelIdentity?.(identity)
      return decide(input)
    }
  }
}

async function hybridSession(
  environment: VisionPolicyInput['operatorEnvironment'],
  dependencies: VisionTaskModelStrategyDependencies
): Promise<VisionTaskModelSession> {
  const reasoner = activeChatSelection(dependencies)
  const specialist = activeSpecialistSelection(dependencies)
  const decisionModelId =
    dependencies.strategy() === 'decision_plus_specialist'
      ? (dependencies.selectedDecisionId?.() ?? selectedDecisionModelId())
      : null
  const [reasonerIdentity, specialistIdentity, decisionIdentity] = await Promise.all([
    dependencies.resolveIdentity(reasoner.modelId),
    dependencies.resolveIdentity(specialist.modelId),
    decisionModelId ? dependencies.resolveIdentity(decisionModelId) : Promise.resolve(null)
  ])
  const modelIdentities = [decisionIdentity, reasonerIdentity, specialistIdentity].filter(
    (identity): identity is ModelIdentity => identity !== null
  )
  return {
    adapter: specialist.adapter,
    identity: {
      modelId: modelIdentities.map((identity) => identity.modelId).join(' + '),
      modelName: modelIdentities.map((identity) => identity.modelName).join(' + ')
    },
    decide: createHybridVisionGrounder(environment, {
      runReasoner: async (...args) => {
        recordComputerUseMetric('reasoningCalls')
        const startedAt = Date.now()
        try {
          const response = await dependencies.runReasoner(...args)
          await recordComputerUseModelCall({
            role: 'reasoning',
            stage: 'vision_reasoning',
            rail: 'vision',
            model: reasonerIdentity.modelId,
            request: args[0],
            response,
            startedAt
          })
          return response
        } catch (error) {
          await recordComputerUseModelCall({
            role: 'reasoning',
            stage: 'vision_reasoning',
            rail: 'vision',
            model: reasonerIdentity.modelId,
            request: args[0],
            error,
            startedAt
          })
          throw error
        }
      },
      withSpecialist: (task) => {
        recordComputerUseMetric('groundingCalls')
        return dependencies.withSpecialist(task)
      },
      activeSpecialistAdapter: () => activeSpecialistSelection(dependencies).adapter,
      specialistModelId: () => specialistIdentity.modelId,
      reasonerIdentity,
      specialistIdentity,
      ...(decisionIdentity ? { decisionIdentity } : {}),
      reasonerProfile: () => {
        const artifacts = dependencies.activeRemote() ? null : dependencies.activeArtifacts()
        return artifacts && bonsaiVisionOperatorAdapter.matches(artifacts)
          ? 'bonsai-json'
          : 'default'
      },
      ...(dependencies.strategy() === 'decision_plus_specialist'
        ? {
            selectStructuredAction: dependencies.decideOptions,
            withReasoning: dependencies.withReasoning
          }
        : {})
    })
  }
}

/** Resolve one immutable model strategy session for a task. Web Use and
 * Computer Use use this same port; only their screen boundary differs. */
export async function withVisionTaskModelStrategy<T>(
  environment: VisionPolicyInput['operatorEnvironment'],
  task: (session: VisionTaskModelSession) => Promise<T>,
  dependencies: VisionTaskModelStrategyDependencies = productionDependencies,
  options: { specialistOnly?: boolean; reasonerOnly?: boolean } = {}
): Promise<T> {
  if (options.specialistOnly) {
    const { result } = await dependencies.withSpecialist(async () => {
      return task(
        await directSession(environment, activeSpecialistSelection(dependencies), dependencies)
      )
    })
    return result
  }
  if (options.reasonerOnly) {
    return task(await directSession(environment, activeChatSelection(dependencies), dependencies))
  }
  const strategy = dependencies.strategy()
  if (strategy === 'text_plus_specialist') {
    return task(await hybridSession(environment, dependencies))
  }
  if (strategy === 'decision_plus_specialist') {
    const session = await hybridSession(environment, dependencies)
    return dependencies.withDecision(() => task(session))
  }
  if (strategy === 'same_as_chat') {
    return task(await directSession(environment, activeChatSelection(dependencies), dependencies))
  }
  if (strategy === 'decision_plus_reasoning') {
    return task(await directSession(environment, activeChatSelection(dependencies), dependencies))
  }
  const { result } = await dependencies.withSpecialist(async () => {
    return task(
      await directSession(environment, activeSpecialistSelection(dependencies), dependencies)
    )
  })
  return result
}
