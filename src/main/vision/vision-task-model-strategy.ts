import { llm } from '../llm'
import { getComputerUseSettings } from '../computer-use-settings'
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
import { getActiveRemoteVisionServer } from './remote-vision-server'
import type { VisionGroundingInput, VisionGroundingResult } from './vision-agent'
import { currentRemoteScreenTaskSession } from '../actions/remote-screen-session'
import { desktopModelServices } from '../model-services'

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
  resolveIdentity(modelId: string): Promise<ModelIdentity>
  withSpecialist<T>(task: () => Promise<T>): Promise<{ result: T }>
  runReasoner: typeof productionHybridReasoner
  resolveGenerationRoute?(modelId: string): Promise<string>
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
  resolveIdentity: resolveModelIdentity,
  withSpecialist: withGrounder,
  runReasoner: productionHybridReasoner,
  resolveGenerationRoute: computerUseRouteId
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
      models: [await projectedModel('grounding_specialist', specialistModelId, false, dependencies)]
    }
  }
  const models: ComputerUseActiveModel[] = []
  if (chatModelId) {
    models.push(await projectedModel('reasoner', chatModelId, Boolean(remote), dependencies))
  }
  models.push(await projectedModel('grounding_specialist', specialistModelId, false, dependencies))
  return { strategy, strategyLabel: 'Text + Specialist', models }
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
  const artifacts = dependencies.activeArtifacts()
  if (!artifacts) {
    throw new Error('The selected Computer Use specialist did not load.')
  }
  return { adapter: resolveVisionModelAdapter(artifacts), modelId: artifacts.id }
}

function specialistFamily(dependencies: VisionTaskModelStrategyDependencies): VisionModelSelection {
  const modelId = dependencies.selectedSpecialistId()
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
  const routeId = await dependencies.resolveGenerationRoute?.(selection.modelId)
  return {
    adapter: selection.adapter,
    identity: await dependencies.resolveIdentity(selection.modelId),
    decide: createVisionGrounder(selection.adapter, environment, routeId)
  }
}

async function computerUseRouteId(modelId: string): Promise<string> {
  await desktopModelServices.refresh()
  const remote = parseRemoteVisionModelId(modelId)
  const matches = desktopModelServices.llm
    .list('computer_use')
    .filter((model) =>
      remote
        ? model.serverId === remote.serverId && model.id === remote.modelId
        : !model.serverId && model.id === modelId
    )
  if (matches.length !== 1 || !matches[0]?.routeId) {
    throw new Error(`The Computer Use model route is unavailable: ${modelId}.`)
  }
  return matches[0].routeId
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
  const [reasonerRouteId, specialistRouteId] = dependencies.resolveGenerationRoute
    ? await Promise.all([
        dependencies.resolveGenerationRoute(reasoner.modelId),
        dependencies.resolveGenerationRoute(specialist.modelId)
      ])
    : [undefined, undefined]
  return {
    adapter: specialist.adapter,
    identity: {
      modelId: `${reasonerIdentity.modelId} + ${specialistIdentity.modelId}`,
      modelName: `${reasonerIdentity.modelName} + ${specialistIdentity.modelName}`
    },
    decide: createHybridVisionGrounder(environment, {
      runReasoner: dependencies.runReasoner,
      withSpecialist: dependencies.withSpecialist,
      activeSpecialistAdapter: () => activeSpecialistSelection(dependencies).adapter,
      reasonerRouteId,
      specialistRouteId
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
  const { result } = await dependencies.withSpecialist(async () => {
    return task(
      await directSession(environment, activeSpecialistSelection(dependencies), dependencies)
    )
  })
  return result
}
