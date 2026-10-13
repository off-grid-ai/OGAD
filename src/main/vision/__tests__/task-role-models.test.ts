// The models a strategy runs, two ways: the task projection (what Tasks and a run name) and the
// shared role map (what the Models screens mark active). They must name the same roles.
import { describe, expect, it } from 'vitest'
import {
  getComputerUseActiveModelProjection,
  type VisionTaskModelStrategyDependencies
} from '../vision-task-model-strategy'
import {
  strategyTaskRoles,
  type ComputerUseModelStrategy
} from '../../../shared/computer-use-settings'

const STRATEGIES: ComputerUseModelStrategy[] = [
  'same_as_chat',
  'separate_specialist',
  'text_plus_specialist',
  'decision_plus_specialist',
  'decision_plus_reasoning'
]

const dependencies = (strategy: ComputerUseModelStrategy): VisionTaskModelStrategyDependencies =>
  ({
    strategy: () => strategy,
    activeArtifacts: () => null,
    activeRemote: () => null,
    selectedChatId: () => 'chat/reasoner',
    selectedSpecialistId: () => 'vision/specialist',
    selectedDecisionId: () => 'decision/selector',
    resolveIdentity: async (modelId: string) => ({ modelId, modelName: modelId })
  }) as unknown as VisionTaskModelStrategyDependencies

describe('task role models', () => {
  it.each(STRATEGIES)('%s: the projection and the role map name the same roles', async (s) => {
    const projection = await getComputerUseActiveModelProjection(dependencies(s))
    const projected = projection.models
      .filter((model) => model.role !== 'reasoner')
      .map((model) => (model.role === 'grounding_specialist' ? 'grounding' : model.role))
    expect(projected).toEqual(strategyTaskRoles(s))
  })
})
