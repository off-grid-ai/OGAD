import { llm } from '../llm'
import { getComputerUseSettings } from '../computer-use-settings'
import { getWebUseSettings } from '../web-use-settings'
import { getActiveModel, resolveModelIdentity, type ModelIdentity } from '../models-manager'
import type {
  ComputerUseActiveModel,
  ComputerUseActiveModelProjection,
  ComputerUseModelStrategy
} from '../../shared/computer-use-settings'
import { remoteVisionModelId } from '../../shared/remote-vision-server'
import { withGrounder, selectedGrounderModelId } from './grounder-loader'
import { createHybridVisionGrounder, productionHybridReasoner } from './hybrid-vision-grounder'
import {
  matchVisionModelAdapter,
  resolveVisionModelAdapter,
  resolveVisionModelAdapterForStrategy
} from './model-adapters'
import { generalVisionOperatorAdapter } from './model-adapters/general-vision-operator'
import type {
  VisionModelAdapter,
  VisionModelArtifacts,
  VisionPolicyInput
} from './model-adapters/types'
import { createVisionGrounder } from './vision-policy-runner'
import { getActiveRemoteVisionServer, getRemoteVisionServerForModel } from './remote-vision-server'
import type { VisionGroundingInput, VisionGroundingResult } from './vision-agent'
import { currentRemoteScreenTaskSession } from '../actions/remote-screen-session'
import { selectedDecisionModelId } from '../accessibility/decision-model-loader'

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
  runReasoner: productionHybridReasoner
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
  dependencies: VisionTaskModelStrategyDependencies = productionDependencies
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
    return {
      strategy,
      strategyLabel: 'Decision + Specialist',
      models: [
        await projectedModel('decision', decisionModelId, Boolean(remoteDecision), dependencies),
        await projectedModel(
          'grounding_specialist',
          specialistModelId,
          Boolean(remoteSpecialist),
          dependencies
        )
      ]
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
  return getComputerUseActiveModelProjection({
    ...productionDependencies,
    strategy: () => getWebUseSettings().modelStrategy,
    selectedDecisionId: () => getWebUseSettings().decisionModelId ?? selectedDecisionModelId()
  })
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
  const remote = getRemoteVisionServerForModel(dependencies.selectedSpecialistId(), 'grounding')
  if (remote) {
    return {
      adapter: generalVisionOperatorAdapter,
      modelId: remoteVisionModelId(remote.id, remote.model)
    }
  }
  const artifacts = dependencies.activeArtifacts()
  if (!artifacts) {
    throw new Error('The selected Computer Use specialist did not load.')
  }
  return { adapter: resolveVisionModelAdapter(artifacts), modelId: artifacts.id }
}

function specialistFamily(dependencies: VisionTaskModelStrategyDependencies): VisionModelSelection {
  const modelId = dependencies.selectedSpecialistId()
  if (getRemoteVisionServerForModel(modelId, 'grounding')) {
    return { modelId, adapter: generalVisionOperatorAdapter }
  }
  return {
    modelId,
    adapter: matchVisionModelAdapter({
      id: modelId,
      primaryFile: modelId,
      projectorFile: null,
      availableFiles: []
    })
  }
}

async function directSession(
  environment: VisionPolicyInput['operatorEnvironment'],
  selection: VisionModelSelection,
  dependencies: VisionTaskModelStrategyDependencies
): Promise<VisionTaskModelSession> {
  return {
    adapter: selection.adapter,
    identity: await dependencies.resolveIdentity(selection.modelId),
    decide: createVisionGrounder(selection.adapter, environment)
  }
}

async function hybridSession(
  environment: VisionPolicyInput['operatorEnvironment'],
  dependencies: VisionTaskModelStrategyDependencies
): Promise<VisionTaskModelSession> {
  const reasoner = activeChatSelection(dependencies)
  const specialist = specialistFamily(dependencies)
  const [reasonerIdentity, specialistIdentity] = await Promise.all([
    dependencies.resolveIdentity(reasoner.modelId),
    dependencies.resolveIdentity(specialist.modelId)
  ])
  return {
    adapter: specialist.adapter,
    identity: {
      modelId: `${reasonerIdentity.modelId} + ${specialistIdentity.modelId}`,
      modelName: `${reasonerIdentity.modelName} + ${specialistIdentity.modelName}`
    },
    decide: createHybridVisionGrounder(environment, {
      runReasoner: dependencies.runReasoner,
      withSpecialist: dependencies.withSpecialist,
      activeSpecialistAdapter: () => activeSpecialistSelection(dependencies).adapter
    })
  }
}

/** Resolve one immutable model strategy session for a task. Web Use and
 * Computer Use use this same port; only their screen boundary differs. */
export async function withVisionTaskModelStrategy<T>(
  environment: VisionPolicyInput['operatorEnvironment'],
  task: (session: VisionTaskModelSession) => Promise<T>,
  dependencies: VisionTaskModelStrategyDependencies = productionDependencies
): Promise<T> {
  const strategy = dependencies.strategy()
  if (strategy === 'text_plus_specialist') {
    return task(await hybridSession(environment, dependencies))
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
