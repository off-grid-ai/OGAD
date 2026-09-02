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
import {
  createHybridVisionGrounder,
  productionHybridReasoner,
  type HybridVisionGrounderDependencies
} from './hybrid-vision-grounder'
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
import {
  ComputerUseSessionApplicationService,
  resolveComputerUseRoleProjection,
  type ComputerUseRoleSelection
} from '@offgrid/models/computer-use'

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
  runSpecialist?: HybridVisionGrounderDependencies['runSpecialist']
  resolveGenerationRoute?(modelId: string, requiredThinking?: boolean): Promise<string>
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
  selection: ComputerUseRoleSelection,
  dependencies: VisionTaskModelStrategyDependencies
): Promise<ComputerUseActiveModel> {
  const identity = await dependencies.resolveIdentity(selection.modelId)
  return { role: selection.role, ...identity, remote: selection.remote }
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
  const projection = resolveComputerUseRoleProjection({
    strategy,
    chatModelId,
    chatRemote: Boolean(remote),
    specialistModelId: dependencies.selectedSpecialistId()
  })
  return {
    strategy: projection.strategy,
    strategyLabel: projection.strategyLabel,
    models: await Promise.all(
      projection.models.map((selection) => projectedModel(selection, dependencies))
    )
  }
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

async function observeModel(
  selection: VisionModelSelection,
  dependencies: VisionTaskModelStrategyDependencies,
  requiredThinking = false
): Promise<{ modelId: string; model: VisionModelAdapter; routeId?: string }> {
  return {
    modelId: selection.modelId,
    model: selection.adapter,
    routeId: await dependencies.resolveGenerationRoute?.(selection.modelId, requiredThinking)
  }
}

export function computerUseRouteIdFromInventory(
  models: readonly import('@offgrid/models').RuntimeModel[],
  modelId: string,
  requiredThinking: boolean
): string {
  const matches = models.filter((model) => model.id === modelId)
  const selected = matches.length === 1 ? matches[0] : undefined
  if (!selected?.routeId) {
    throw new Error(`The Computer Use model route is unavailable: ${modelId}.`)
  }
  if (requiredThinking && selected.capabilities.thinking !== true) {
    throw new Error(
      `${selected.name || modelId} does not support the required capabilities: thinking.`
    )
  }
  return selected.routeId
}

async function computerUseRouteId(modelId: string, requiredThinking = false): Promise<string> {
  await desktopModelServices.refresh()
  const remote = parseRemoteVisionModelId(modelId)
  const matches = desktopModelServices.llm
    .list('computer_use')
    .filter((model) =>
      remote
        ? model.serverId === remote.serverId && model.id === remote.modelId
        : !model.serverId && model.id === modelId
    )
  return computerUseRouteIdFromInventory(matches, remote?.modelId ?? modelId, requiredThinking)
}

function createVisionTaskModelService(
  dependencies: VisionTaskModelStrategyDependencies
): ComputerUseSessionApplicationService<
  VisionPolicyInput['operatorEnvironment'],
  VisionModelAdapter,
  VisionGroundingInput,
  VisionGroundingResult
> {
  return new ComputerUseSessionApplicationService({
    strategy: dependencies.strategy,
    observeChatModel: () => observeModel(activeChatSelection(dependencies), dependencies, true),
    observeSpecialistModel: () => observeModel(specialistFamily(dependencies), dependencies),
    observeActiveSpecialistModel: () =>
      observeModel(activeSpecialistSelection(dependencies), dependencies),
    resolveIdentity: dependencies.resolveIdentity,
    runWithSpecialist: async (task) => (await dependencies.withSpecialist(task)).result,
    createDirectDecision: ({ environment, selection }) =>
      createVisionGrounder(selection.model, environment, selection.routeId),
    createHybridDecision: ({
      environment,
      reasoner,
      specialist,
      runWithSpecialist,
      observeActiveSpecialistModel
    }) =>
      createHybridVisionGrounder(environment, {
        runReasoner: dependencies.runReasoner,
        withSpecialist: async (task) => ({ result: await runWithSpecialist(task) }),
        activeSpecialistAdapter: async () => (await observeActiveSpecialistModel()).model,
        runSpecialist: dependencies.runSpecialist,
        reasonerRouteId: reasoner.routeId,
        specialistRouteId: specialist.routeId
      })
  })
}

/** Resolve one immutable model strategy session for a task. Web Use and
 * Computer Use use this same port; only their screen boundary differs. */
export async function withVisionTaskModelStrategy<T>(
  environment: VisionPolicyInput['operatorEnvironment'],
  task: (session: VisionTaskModelSession) => Promise<T>,
  dependencies: VisionTaskModelStrategyDependencies = productionDependencies
): Promise<T> {
  return createVisionTaskModelService(dependencies).withSession(environment, (session) =>
    task({ adapter: session.model, identity: session.identity, decide: session.decide })
  )
}
